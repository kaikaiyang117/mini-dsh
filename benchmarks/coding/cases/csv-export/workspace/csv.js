export function toCsv(rows) { const keys = Object.keys(rows[0] ?? {}); return [keys.join(','), ...rows.map((row) => keys.map((key) => String(row[key] ?? '')).join(','))].join('\\n') }
