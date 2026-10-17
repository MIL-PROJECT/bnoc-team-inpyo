export class RequestStatusCalculator {
  static deriveStatus(request, workItems) {
    if (request.status === '취소') return '취소';
    if (request.status === '문서 대기') return '문서 대기';
    const valid = workItems.filter(work => work.status !== '반환');
    if (valid.some(work => work.status === '작업 중')) return '작업 중';
    if (workItems.some(work => work.status === '반환' && !work.resolvedByWorkItemIds.length)) return '대기';
    if (valid.length && valid.every(work => work.status === '완료')) return '완료';
    if (valid.length) return '배정';
    return '대기';
  }
}
