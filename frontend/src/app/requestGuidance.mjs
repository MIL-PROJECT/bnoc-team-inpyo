const resourceLabels = {
  PC: 'PC',
  프린터: '프린터',
  회선: '회선',
  전화: '전화기',
  기타: '기타 자원'
};

const workExamples = {
  신설: '새로 설치할 위치와 필요한 구성을 적어주세요.',
  고장: '발생 증상과 처음 확인한 시점을 적어주세요.',
  지원: '필요한 지원 내용과 희망 시점을 적어주세요.',
  대여: '필요한 장비와 수량, 사용 기간을 적어주세요.',
  점검: '점검 대상과 확인을 원하는 항목을 적어주세요.',
  이전: '이전 대상과 현재 위치, 옮길 위치를 적어주세요.',
  기타: '필요한 작업과 참고할 내용을 적어주세요.'
};

const meetingExamples = {
  화상회의: '회의 일시, 접속 방식, 필요한 장비나 연결 지원을 적어주세요.',
  일반회의: '회의 일시, 장소, 좌석·음향 등 필요한 지원을 적어주세요.',
  기타: '회의 일시와 필요한 지원 내용을 적어주세요.'
};

export function requestDetailGuidance(input) {
  if (input.category === '회의 지원') {
    return `예: ${input.meetingType || '회의'} 지원이 필요합니다. ${meetingExamples[input.meetingType] ?? meetingExamples.기타}`;
  }
  const system = input.systemType || '체계 종류';
  const resource = resourceLabels[input.resourceType] ?? '자원';
  const work = workExamples[input.workType] ?? workExamples.기타;
  return `예: ${system} ${resource} ${input.workType || '작업'} 작업이라면 ${work}`;
}

export const requestLocationGuidance = '예: 건물 층 부서명 등 작업 위치를 적어주세요.';
