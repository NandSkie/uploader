/**
 * Cloudflare Worker — Upload Proxy (Streaming + Retry)
 *
 * Features:
 *   - Pure streaming upload (no memory buffering)
 *   - Support files up to 100MB
 *   - Auto retry untuk gangguan jaringan / DNS sesaat
 *   - No file content inspection
 *   - CORS enabled
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, X-Uploader-Url, X-Uploader-Headers, X-Response-Path, X-File-Type',
  'Access-Control-Max-Age': '86400',
};

// Max file size: 100MB
const MAX_FILE_SIZE = 100 * 1024 * 1024;

// Konfigurasi retry
const MAX_RETRIES = 2;        // total percobaan tambahan (2 = total 3x coba)
const RETRY_BASE_DELAY = 800; // ms, akan dikali (attempt + 1)

/**
 * Extract nested value using dot notation (e.g. "data.file.url")
 */
function getNestedValue(obj, path) {
  if (!path || !obj) return null;
  return path.split('.').reduce((acc, key) => acc?.[key], obj) ?? null;
}

/**
 * Extract URL from various response formats.
 */
function extractUrlFromResponse(data, responsePath) {
  if (!data) return null;

  if (responsePath) {
    const url = getNestedValue(data, responsePath);
    if (url && typeof url === 'string') return url;
  }

  const commonFields = [
    'downloadLinkEncoded',
    'downloadLink',
    'url',
    'link',
    'fileUrl',
    'file_url',
  ];
  for (const field of commonFields) {
    if (data[field] && typeof data[field] === 'string') return data[field];
  }

  return null;
}

/**
 * Build JSON response dengan CORS headers.
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

/**
 * Fetch dengan retry otomatis.
 *
 * PENTING: body request.body (stream) cuma bisa dipakai sekali.
 * Karena itu retry di sini HANYA aman untuk request yang body-nya
 * sudah di-buffer. Untuk streaming murni, retry tetap dijalankan,
 * tapi kalau percobaan pertama sudah mengirim sebagian body,
 * percobaan kedua akan gagal — ini tidak bisa dihindari di Worker.
 *
 * Solusinya: retry difokuskan untuk error koneksi SEBELUM body terkirim
 * (DNS gagal, TLS gagal, koneksi ditolak) — yang paling sering terjadi
 * saat ISP blokir DNS.
 */
async function fetchWithRetry(url, options) {
  let lastError;
  let lastResponse;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, options);

      // Server error 5xx → coba lagi (kalau masih ada slot retry)
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        lastResponse = response;
        await new Promise((r) =>
          setTimeout(r, RETRY_BASE_DELAY * (attempt + 1))
        );
        continue;
      }

      // Sukses atau error 4xx (client error) → langsung kembalikan
      return response;
    } catch (error) {
      // Error jaringan / DNS / TLS → coba lagi
      lastError = error;

      if (attempt < MAX_RETRIES) {
        console.warn(
          `Fetch attempt ${attempt + 1} failed: ${error.message}. Retrying...`
        );
        await new Promise((r) =>
          setTimeout(r, RETRY_BASE_DELAY * (attempt + 1))
        );
      }
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError || new Error('Fetch failed after retries');
}

export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only allow POST method
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed. Use POST.' }, 405);
    }

    try {
      // Check content length if available
      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        return jsonResponse(
          { error: 'File too large. Maximum size: 100MB' },
          413
        );
      }

      // Get upload configuration from headers
      const uploadUrl =
        request.headers.get('x-uploader-url') ||
        'https://tmpfile.link/api/upload';
      const responsePath = request.headers.get('x-response-path');
      const fileType = request.headers.get('x-file-type');

      // Parse custom headers for upstream
      let customHeaders = {};
      const customHeadersStr = request.headers.get('x-uploader-headers');
      if (customHeadersStr) {
        try {
          customHeaders = JSON.parse(customHeadersStr);
        } catch {
          // Invalid JSON, ignore
        }
      }

      // Prepare upstream headers
      const upstreamHeaders = new Headers();

      const contentType = request.headers.get('content-type');
      if (contentType) upstreamHeaders.set('content-type', contentType);

      if (contentLength) upstreamHeaders.set('content-length', contentLength);

      Object.entries(customHeaders).forEach(([key, value]) => {
        upstreamHeaders.set(key, value);
      });

      if (fileType) upstreamHeaders.set('x-file-type', fileType);

      // Stream body ke upstream dengan retry otomatis
      const upstreamResponse = await fetchWithRetry(uploadUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: request.body,
      });

      // Handle upstream errors
      if (!upstreamResponse.ok) {
        let errorText = '';
        try {
          errorText = await upstreamResponse.text();
          errorText = errorText.substring(0, 500);
        } catch {
          errorText = 'Unable to read error response';
        }

        return jsonResponse(
          {
            error: `Upstream error ${upstreamResponse.status}`,
            details: errorText,
          },
          502
        );
      }

      // Read upstream response
      const responseText = await upstreamResponse.text();
      let fileUrl = null;
      let rawResult = null;

      try {
        rawResult = JSON.parse(responseText);
        fileUrl = extractUrlFromResponse(rawResult, responsePath);
      } catch {
        const trimmedText = responseText.trim();
        if (
          trimmedText &&
          (trimmedText.startsWith('http://') ||
            trimmedText.startsWith('https://'))
        ) {
          fileUrl = trimmedText;
        }
      }

      return jsonResponse({
        success: true,
        url: fileUrl,
        raw: !fileUrl && rawResult ? rawResult : undefined,
      });
    } catch (error) {
      console.error('Worker error:', error);

      // Deteksi error DNS secara eksplisit untuk pesan yang lebih jelas
      const msg = (error.message || '').toLowerCase();
      const isDnsError =
        msg.includes('dns') ||
        msg.includes('resolve') ||
        msg.includes('getaddrinfo') ||
        msg.includes('enotfound');

      return jsonResponse(
        {
          error: isDnsError
            ? 'Gagal resolve DNS server tujuan. Coba ganti DNS ke 1.1.1.1 atau 8.8.8.8 di perangkatmu.'
            : 'Internal server error',
          message: error.message,
        },
        500
      );
    }
  },
};
