const cpconStages: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V' };

export function cpconStageValue(stageCode: string | number | null | undefined): string | null {
  return stageCode == null ? null : cpconStages[String(stageCode)] ?? null;
}
