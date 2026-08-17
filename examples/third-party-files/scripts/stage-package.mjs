#!/usr/bin/env node

import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const packageRoot = join(projectRoot, 'dist', 'package')
mkdirSync(join(packageRoot, 'frontend'), { recursive: true })
cpSync(join(projectRoot, 'manifest.json'), join(packageRoot, 'manifest.json'))
cpSync(join(projectRoot, 'index.html'), join(packageRoot, 'frontend', 'index.html'))
