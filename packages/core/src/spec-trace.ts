export function extractSpecFailureCodes(spec: string): string[] {
  return sortStrings(
    [...extractSection(spec, "##### 4.2.1.1", "### 4.3").matchAll(/\| `([a-z_]+)` \|/g)].map(
      (match) => match[1],
    ),
  );
}

export function extractSpecFailureAuditKinds(spec: string): string[] {
  return sortStrings(
    [...extractSection(spec, "##### 10.2.2.2", "### 10.3").matchAll(/^- `([a-z_]+)`/gm)].map(
      (match) => match[1],
    ),
  );
}

export function extractSpecOperationalAuditKinds(spec: string): string[] {
  return sortStrings(
    [
      ...extractSection(spec, "##### 10.2.2.1", "##### 10.2.2.2").matchAll(/^\| `([a-z_]+)` \|/gm),
    ].map((match) => match[1]),
  );
}

export function extractSpecE34Rows(spec: string): string[] {
  return [...extractSection(spec, "### 5.1", "### 5.2").matchAll(/^\| E34 \|.*$/gm)].map(
    (match) => match[0],
  );
}

export function sortStrings(values: string[]): string[] {
  return values.sort((left, right) => left.localeCompare(right));
}

function extractSection(spec: string, start: string, end: string): string {
  const startIndex = spec.indexOf(start);
  if (startIndex === -1) {
    throw new Error(`missing section start: ${start}`);
  }

  const endIndex = spec.indexOf(end, startIndex + start.length);
  if (endIndex === -1) {
    throw new Error(`missing section end: ${end}`);
  }

  return spec.slice(startIndex, endIndex);
}
