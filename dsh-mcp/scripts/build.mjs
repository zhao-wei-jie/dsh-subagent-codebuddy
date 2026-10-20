#!/usr/bin/env node
/**
 * Build @flg1217/dsh-mcp:tsc 编译 src/*.ts → lib/*.js + lib/types/*.d.ts。
 * 纯服务端插件(无客户端 bundle)。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = join(root, '..')
const outDir = join(pkg, 'lib')

console.log('build: cleaning lib/')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

console.log('build: tsc (src/*.ts → lib/)')
execFileSync('npx', ['tsc', '-p', join(pkg, 'tsconfig.json')], { stdio: 'inherit', shell: true })
