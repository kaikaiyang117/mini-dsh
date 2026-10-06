import fs from 'node:fs/promises'
import path from 'node:path'

export async function snapshotWorkspace(workspace) {
    const files = {}
    await visit(workspace, workspace, files)
    return files
}

async function visit(root, current, files) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name)
        if (entry.isDirectory()) await visit(root, absolute, files)
        else if (entry.isFile())
            files[path.relative(root, absolute).split(path.sep).join('/')] = await fs.readFile(
                absolute,
                'utf8',
            )
    }
}

export function diffWorkspace(initial, final) {
    const createdFiles = Object.keys(final)
        .filter((name) => !(name in initial))
        .sort()
    const deletedFiles = Object.keys(initial)
        .filter((name) => !(name in final))
        .sort()
    const modifiedFiles = Object.keys(final)
        .filter((name) => name in initial && final[name] !== initial[name])
        .sort()
    return {
        createdFiles,
        modifiedFiles,
        deletedFiles,
        changedFiles: [...new Set([...createdFiles, ...modifiedFiles, ...deletedFiles])].sort(),
    }
}

export async function copyWorkspace(source, destination) {
    await fs.mkdir(destination, { recursive: true })
    await fs.cp(source, destination, { recursive: true })
}
