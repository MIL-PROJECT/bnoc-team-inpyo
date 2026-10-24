import { schedulePreferenceInput, schedulePreferencesFromInput } from '../api/schedulePreferences.mjs';

export const requestOptions = {
  categories: ['장비/체계', '회의 지원'],
  systemTypes: ['인트라넷', '인터넷', 'AFCCS', 'KJCCS', '기타'],
  resourceTypes: ['PC', '프린터', '회선', '전화', '기타'],
  workTypes: ['신설', '고장', '지원', '대여', '점검', '이전', '기타'],
  meetingTypes: ['화상회의', '일반회의', '기타'],
  phoneTypes: ['IP', '아날로그', '인터컴', '비상벨']
};

export function initialDraft() {
  return {
    category: '장비/체계', systemType: '', resourceType: '', workType: '', meetingType: '', phoneType: '',
    detail: '', location: '', contact: '', equipmentId: '', ...schedulePreferenceInput(), documentRef: '',
    differentTarget: false, targetDepartment: '', targetRank: '', targetName: '', targetPhone: '',
    requesterDisplayText: '', actualRequesterText: '', actualStartedAt: '', reason: '', completionMemo: '',
    completedAt: '', completionConfirmed: false
  };
}

export function validateDraft(input, role, afterAction = false) {
  const errors = {};
  const required = (key, value, label) => {
    if (!String(value ?? '').trim()) errors[key] = `${label}을(를) 입력하세요.`;
  };
  required('category', input.category, '요청 유형');
  required('detail', input.detail, '요청 내용·증상');
  required('location', input.location, '작업 위치');
  required('contact', input.contact, '요청자 군내전화번호');
  if (role === 'bnoc') required('requesterDisplayText', input.requesterDisplayText, '실제 요청자');

  if (input.category === '장비/체계') {
    required('systemType', input.systemType, '체계 종류');
    required('resourceType', input.resourceType, '자원 유형');
    required('workType', input.workType, '작업 유형');
    if (!requestOptions.systemTypes.includes(input.systemType)) errors.systemType = '체계 종류를 선택하세요.';
    if (!requestOptions.resourceTypes.includes(input.resourceType)) errors.resourceType = '자원 유형을 선택하세요.';
    if (!requestOptions.workTypes.includes(input.workType)) errors.workType = '작업 유형을 선택하세요.';
    if (input.resourceType === '전화' && input.phoneType && !requestOptions.phoneTypes.includes(input.phoneType)) errors.phoneType = '전화기 종류를 확인하세요.';
  } else if (input.category === '회의 지원') {
    required('meetingType', input.meetingType, '회의 유형');
    if (!requestOptions.meetingTypes.includes(input.meetingType)) errors.meetingType = '회의 유형을 선택하세요.';
  }

  if (input.differentTarget) {
    for (const [key, label] of [['targetDepartment', '정비대상자 소속'], ['targetRank', '정비대상자 계급'], ['targetName', '정비대상자 이름'], ['targetPhone', '정비대상자 군내전화번호']]) required(key, input[key], label);
  }

  if (!afterAction) Object.assign(errors, validatePreferences(input));
  if (afterAction) {
    required('actualRequesterText', input.actualRequesterText, '실제 요청자');
    required('actualStartedAt', input.actualStartedAt, '실제 시작 시각');
    required('completedAt', input.completedAt, '실제 완료 시각');
    required('reason', input.reason, '선조치 사유');
    if (input.actualStartedAt && input.completedAt && Date.parse(input.actualStartedAt) > Date.parse(input.completedAt)) errors.completedAt = '완료 시각은 시작 시각 이후로 입력하세요.';
    if (!input.completionConfirmed) errors.completionConfirmed = '완료한 작업인지 확인하세요.';
  }

  const files = [...(input.files ?? []), ...(input.existingDocuments ?? []).map(doc => ({ name: doc.name, size: doc.originalFile?.size ?? doc.size ?? 0 }))];
  if (files.length > 10 || files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024 || files.some(file => file.size > 10 * 1024 * 1024 || !['pdf', 'doc', 'docx', 'hwp', 'hwpx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'png', 'jpg', 'jpeg'].includes(file.name.split('.').pop().toLowerCase()))) {
    errors.files = '첨부는 허용 형식, 파일당10MiB·최대10개·합계50MiB로 선택하세요.';
  }
  return errors;
}

export function draftFromRequest(record) {
  const base = initialDraft();
  if (!record) return base;
  return {
    ...base,
    existingDocuments: record.documents ?? [],
    category: record.category ?? base.category,
    systemType: record.systemType ?? '', resourceType: record.resourceType ?? '',
    workType: record.category === '회의 지원' ? '' : record.workType ?? '',
    meetingType: record.category === '회의 지원' ? record.workType ?? '' : '',
    phoneType: record.phoneType ?? '', detail: record.detail ?? '', location: record.location ?? '', contact: record.contact ?? '',
    ...schedulePreferenceInput(record.schedulePreferences), documentRef: record.documentRef ?? '',
    requesterDisplayText: record.requesterDisplayText ?? '',
    differentTarget: Boolean(record.maintenanceTarget),
    targetDepartment: record.maintenanceTarget?.department ?? '', targetRank: record.maintenanceTarget?.rank ?? '',
    targetName: record.maintenanceTarget?.name ?? '', targetPhone: record.maintenanceTarget?.phone ?? ''
  };
}

export function validatePreferences(input) {
  const errors = {};
  const preferences = schedulePreferencesFromInput(input);
  for (const choice of preferences) {
    const dateKey = `preference${choice.rank}Date`;
    const periodKey = `preference${choice.rank}Period`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(choice.date ?? '') || Number.isNaN(Date.parse(choice.date)) || new Date(choice.date).toISOString().slice(0, 10) !== choice.date) errors[dateKey] = '희망 날짜를 선택하세요.';
    if (!['AM', 'PM'].includes(choice.period)) errors[periodKey] = '오전 또는 오후를 선택하세요.';
  }
  if (preferences.some(item => item.rank === 2) && !preferences.some(item => item.rank === 1)) errors.preference1Date = '2지망은 1지망과 함께 입력하세요.';
  return errors;
}
