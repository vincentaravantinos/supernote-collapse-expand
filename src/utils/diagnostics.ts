export function summarizeElement(el: any): string {
  if (!el) return '(null)';
  const parts: string[] = [
    `num=${el.numInPage}`,
    `type=${el.type}`,
    `page=${el.pageNum}`,
    `layer=${el.layerNum}`,
    `maxX=${el.maxX}`,
    `maxY=${el.maxY}`,
  ];
  if (typeof el.userData === 'string' && el.userData.length > 0) {
    parts.push(`udLen=${el.userData.length}`);
  }
  if (el.stroke) {
    parts.push(`penType=${el.stroke.penType}`, `penColor=${el.stroke.penColor}`, `thickness=${el.thickness}`);
  }
  if (el.recognizeResult?.predict_name) {
    parts.push(`predict=${el.recognizeResult.predict_name}`);
  }
  return `(${parts.join(' ')})`;
}

export function summarizeElements(elements: any[]): string {
  return `count=${elements.length} ${elements.map(summarizeElement).join(', ')}`;
}

export function summarizeSection(section: any): string {
  if (!section) return '(null)';
  const r = section.iconRect ?? {};
  const rr = section.relativeRect ?? {};
  const kindCounts = new Map<string, number>();
  for (const ce of section.collapsedElements ?? []) {
    const k = ce?.data?.kind ?? 'unknown';
    kindCounts.set(k, (kindCounts.get(k) ?? 0) + 1);
  }
  const kindStr = Array.from(kindCounts.entries()).map(([k, n]) => `${n} ${k}`).join(', ');
  const preserved = section.preservedNums ?? [];
  return `(id=${section.id} expanded=${section.isExpanded} schemaV=${section.schemaVersion}` +
    ` iconRect=[${r.left},${r.top},${r.right},${r.bottom}]` +
    ` relRect=(${rr.width}x${rr.height}@${rr.left},${rr.top})` +
    ` collapsed=${section.collapsedElements?.length ?? 0}${kindStr ? ` [${kindStr}]` : ''}` +
    ` preservedNums=[${preserved.join(',')}])`;
}
