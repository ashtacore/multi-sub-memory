const csrfToken = document.querySelector('meta[name="msm-csrf-token"]').content;

async function request(path, { params, signal, method = 'GET', body } = {}) {
  const query = params && new URLSearchParams(params).toString();
  const response = await fetch('/api/' + path + (query ? '?' + query : ''), {
    method,
    signal,
    headers: {
      ...(method === 'GET' ? {} : { 'X-MSM-Token': csrfToken }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response.json();
    const error = new Error(result.error ?? 'Dashboard request failed');
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function api(path, options) {
  return (await request(path, options)).json();
}

export async function downloadAnalytics(params, format) {
  const response = await request('analytics/export', { params: { ...params, format } });
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = format === 'markdown' ? 'memory-analytics.md' : 'memory-analytics.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
