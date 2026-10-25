export class ApiError extends Error {
  constructor(code, message, status = 0, fieldErrors, refreshRequired = false) {
    super(message); this.name = 'ApiError'; this.code = code; this.status = status; this.fieldErrors = fieldErrors; this.refreshRequired = refreshRequired;
  }
}

export class ApiClient {
  constructor(fetcher = (...args) => globalThis.fetch(...args)) { this.fetcher = fetcher; this.csrfToken = ''; this.onUnauthenticated = null; }
  async send(path, options = {}) {
    const method = options.method ?? 'GET';
    const command = (path === '/commands' && method === 'POST') || (path.startsWith('/planned-works') && ['POST', 'PATCH'].includes(method));
    const unknownSaveMessage = '저장 결과를 확인하지 못했습니다. 입력은 유지됩니다. 같은 제출로 다시 확인하세요.';
    const headers = { Accept: 'application/json', ...(options.headers ?? {}) };
    if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = this.csrfToken;
    if (typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    let response;
    try { response = await this.fetcher('/api' + path, { ...options, method, credentials: 'same-origin', headers }); }
    catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ApiError('NETWORK', command ? unknownSaveMessage : '서버에 연결하지 못했습니다. 입력은 유지됩니다.');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError('INVALID_RESPONSE', command && response.ok && response.status !== 202 ? unknownSaveMessage : '서버 응답을 확인하지 못했습니다.', response.status); }
    if (!response.ok || response.status === 202 || data.ok === false) {
      const code = data.errorCode ?? data.code ?? (response.status === 401 ? 'UNAUTHENTICATED' : response.status === 202 ? 'PROCESSING' : 'SAVE_FAILED');
      if (response.status === 401 || code === 'UNAUTHENTICATED') this.onUnauthenticated?.();
      throw new ApiError(code, data.message ?? (code === 'PROCESSING' ? '서버에서 같은 제출을 처리 중입니다. 잠시 후 같은 제출로 다시 확인하세요.' : '요청을 처리하지 못했습니다.'), response.status, data.fieldErrors, data.refreshRequired);
    }
    return data;
  }
  async query(path, signal, arrayFields = []) {
    const envelope = await this.send(path, { signal });
    if (!envelope || typeof envelope !== 'object' || !Object.hasOwn(envelope, 'data')) throw new ApiError('INVALID_RESPONSE', '서버 조회 응답의 형식을 확인하지 못했습니다.');
    const data = envelope.data;
    if (!data || typeof data !== 'object') throw new ApiError('INVALID_RESPONSE', '서버 조회 응답의 내용을 확인하지 못했습니다.');
    const result = { ...(Array.isArray(data) ? { items: data } : data), ...Object.fromEntries(['queriedAt','total','page','size'].filter(key => envelope[key] !== undefined).map(key => [key, envelope[key]])) };
    if (arrayFields.some(key => !Array.isArray(result[key]))) throw new ApiError('INVALID_RESPONSE', '서버 목록 응답의 형식을 확인하지 못했습니다.');
    return result;
  }
  async session(signal) { const session = await this.query('/session', signal); this.csrfToken = session.csrfToken; return session; }
  async startLogin() { const challenge = await this.query('/auth/start'); this.csrfToken = challenge.csrfToken; return challenge; }
  completeLogin(ticket, loginAttempt) { return this.send('/auth/complete', { method: 'POST', body: JSON.stringify({ ticket, loginAttempt }) }); }
  logout() { return this.send('/auth/logout', { method: 'POST', body: '{}' }); }
  dispatch(command) {
    const body = {};
    for (const key of ['type', 'operationId', 'requestNumber', 'workNumber', 'expectedRevision', 'payload']) if (command[key] !== undefined) body[key] = command[key];
    return this.send('/commands', { method: 'POST', body: JSON.stringify(body) });
  }
  getRequestList(criteria = {}, signal) { return this.query('/requests' + queryString(criteria), signal, ['items']); }
  getRequesters(signal) { return this.query('/requesters', signal, ['items']); }
  getRequestDetail(number, signal) { return this.query('/requests/' + encodeURIComponent(number), signal); }
  getHistory(number, signal, criteria = {}) { return this.query('/requests/' + encodeURIComponent(number) + '/history' + queryString(criteria), signal, ['items']); }
  getNotifications(signal, criteria = {}) { return this.query('/notifications' + queryString(criteria), signal, ['items']); }
  getNotificationUnseen(signal) { return this.query('/notifications/unseen', signal); }
  getTeamSchedule(range = {}, signal) { return this.query('/schedule' + queryString(range), signal, ['entries','unscheduled']); }
  getBnocOverview(criteria = {}, signal) { return this.query('/overview' + queryString(criteria), signal, ['list']); }
  getWorkOverview(criteria = {}, signal) { return this.query('/work-overview' + queryString(criteria), signal, ['items','byDepartment']); }
  getPlannedWorks(workDate, signal) { return this.query('/planned-works' + queryString({ workDate }), signal, ['inProgress','completed']); }
  async createPlannedWork(input) { return (await this.send('/planned-works', { method: 'POST', body: JSON.stringify(input) })).data; }
  async updatePlannedWork(id, input) { return (await this.send('/planned-works/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(input) })).data; }
  async completePlannedWork(id, input) { return (await this.send('/planned-works/' + encodeURIComponent(id) + '/complete', { method: 'POST', body: JSON.stringify(input) })).data; }
  async deletePlannedWork(id, revision) { return (await this.send('/planned-works/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'If-Match': `"${revision}"` } })).data; }
  getRoster(department, signal) { return this.query('/personnel-roster' + queryString({ department }), signal, ['entries']); }
  getPersonnel(criteria = {}, signal) { return this.query('/personnel' + queryString(criteria), signal, ['departments']); }
  getNightDuty(criteria = {}, signal) { return this.query('/night-duty' + queryString(criteria), signal, ['departments']); }
  getSituation(signal) { return this.query('/situation', signal); }
  getNotices(criteria = {}, signal) { return this.query('/notices' + queryString(criteria), signal, ['items']); }
  getNotice(ref, signal) { return this.query('/notices/' + encodeURIComponent(ref), signal); }
  getAccess(signal, criteria = {}) { return this.query('/access-assignments' + queryString(criteria), signal, ['items']); }
  async uploadAttachment(file, resourceKind = 'request') {
    const form = new FormData(); form.append('file', file);
    const result = await this.send('/attachments?resourceKind=' + encodeURIComponent(resourceKind), { method: 'POST', body: form });
    return result.data ?? result;
  }
  attachmentUrl(id) { return '/api/attachments/' + encodeURIComponent(id); }
  attachmentInlineUrl(id) { return '/api/attachments/' + encodeURIComponent(id) + '/inline'; }
  async getAttachmentRenderSource(id, signal) {
    let response;
    try {
      response = await this.fetcher('/api/attachments/' + encodeURIComponent(id) + '/render-source', {
        method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/octet-stream' }, signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
        throw new ApiError('NETWORK', '문서 원본에 연결하지 못했습니다.');
    }
    if (!response.ok) {
      let data = {};
      try { data = await response.json(); } catch { /* use the response status */ }
      const code = data.errorCode ?? data.code ?? (response.status === 401 ? 'UNAUTHENTICATED' : 'ATTACHMENT_UNAVAILABLE');
      if (response.status === 401 || code === 'UNAUTHENTICATED') this.onUnauthenticated?.();
        throw new ApiError(code, data.message ?? '문서 원본을 열 수 없습니다.', response.status, data.fieldErrors);
    }
      if (response.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/octet-stream') throw new ApiError('INVALID_RESPONSE', '문서 원본 응답 형식을 확인할 수 없습니다.', response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new ApiError('INVALID_RESPONSE', '문서 원본 크기를 확인할 수 없습니다.', response.status);
    return bytes;
  }
  getAttachmentDocument(id, offset = 0, limit = 50, signal) { return this.query('/attachments/' + encodeURIComponent(id) + '/document' + queryString({ offset, limit }), signal); }
  async reprocessAttachment(id) { return (await this.send('/attachments/' + encodeURIComponent(id) + '/reprocess', { method: 'POST', body: '{}' })).data; }
}

export function queryString(criteria = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(criteria)) {
    if (key === 'period') { if (value?.from) search.set('from', value.from); if (value?.to) search.set('to', value.to); }
    else if (Array.isArray(value)) value.forEach(item => search.append(key, String(item)));
    else if (value != null && value !== '') search.set(key, String(value));
  }
  return search.size ? '?' + search.toString() : '';
}
