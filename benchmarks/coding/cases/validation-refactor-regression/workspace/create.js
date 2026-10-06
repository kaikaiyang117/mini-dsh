export function create(input) { if (!input.name) throw new Error('name required'); return { ...input } }
