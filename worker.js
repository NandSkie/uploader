/**
 * Cloudflare Worker — Upload Proxy (Multipart Version)
 * Kompatibel dengan tmpfile.link dan server multipart lainnya.
 *
 * ⚠️ Tidak streaming — file di-buffer di memory.
 * Limit: ~100MB (memory Worker ~128MB).
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, X-Uploader-Url, X-Uploader-Headers, X-Response-Path, X-File-Type, X-File-Name',
  'Access-Control-Max-Age': '86400',
};

const MAX_FILE_SIZE = 100 * 1024 * 1024;

function getNestedValue(obj, path) {
  if (!path || !obj) return null;
  return path.split('.').reduce((acc, key) => acc?.[key], obj) ?? null;
}

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

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed. Use POST.' }, 405);
    }

    try {
      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        return jsonResponse(
          { error: 'File too large. Maximum size: 100MB' },
          413
        );
      }

      const uploadUrl =
        request.headers.get('x-uploader-url') ||
        'https://tmpfile.link/api/upload';
      const responsePath = request.headers.get('x-response-path');
      const fileName =
        request.headers.get('x-file-name') || 'upload.bin';
      const fileType =
        request.headers.get('x-file-type') ||
        request.headers.get('content-type') ||
        'application/octet-stream';

      let customHeaders = {};
      const customHeadersStr = request.headers.get('x-uploader-headers');
      if (customHeadersStr) {
        try {
          customHeaders = JSON.parse(customHeadersStr);
        } catch {}
      }

      // Buffer file ke memory (⚠️ tidak streaming)
      const fileBuffer = await request.arrayBuffer();

      // Bikin FormData & append file
      const formData = new FormData();
      const blob = new Blob([fileBuffer], { type: fileType });
      formData.append('file', blob, fileName);

      // Prepare headers upstream
      const upstreamHeaders = new Headers();
      // ⚠️ JANGAN set Content-Type — biar fetch yang set boundary otomatis
      Object.entries(customHeaders).forEach(([key, value]) => {
        upstreamHeaders.set(key, value);
      });

      const upstreamResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: formData,
      });

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

      const responseText = await upstreamResponse.text();
      let fileUrl = null;
      let rawResult = null;

      try {
        rawResult = JSON.parse(responseText);
        fileUrl = extractUrlFromResponse(rawResult, responsePath);
      } catch {
        const trimmedText = responseText.trim();
        if (
          trimmedText.startsWith('http://') ||
          trimmedText.startsWith('https://')
        ) {
          fileUrl = trimmedText;
        } else {
          const urlMatch = trimmedText.match(/https?:\/\/[^\s]+/);
          if (urlMatch) fileUrl = urlMatch[0];
        }
      }

      return jsonResponse({
        success: true,
        url: fileUrl,
        raw: !fileUrl && rawResult ? rawResult : undefined,
      });
    } catch (error) {
      console.error('Worker error:', error);
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
