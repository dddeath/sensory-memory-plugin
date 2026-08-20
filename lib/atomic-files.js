import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export function fsyncDirectory(path) {
  let descriptor
  try {
    descriptor = openSync(dirname(path), 'r')
    fsyncSync(descriptor)
  } catch {
    // Directory fsync is not exposed consistently on Windows. The file has
    // already been flushed, so rename still remains atomic there.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export function atomicWriteFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx')
    writeFileSync(descriptor, contents, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    fsyncDirectory(path)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

export function appendAndFsync(path, contents) {
  if (!contents) return 0
  mkdirSync(dirname(path), { recursive: true })
  const descriptor = openSync(path, 'a')
  try {
    writeFileSync(descriptor, contents, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  return Buffer.byteLength(contents)
}

export function atomicWriteJson(path, value) {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`)
}
