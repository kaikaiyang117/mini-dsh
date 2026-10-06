export function update(current, input) { if (!input.name) throw new Error('name required'); return { ...current, ...input } }
