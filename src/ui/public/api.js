const csrfToken = document.querySelector('meta[name="msm-csrf-token"]').content;

export async function api(path, { params, signal, method = 'GET', body } = {}) {
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
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error ?? 'Dashboard request failed');
    error.status = response.status;
    throw error;
  }
  return result;
}
