import { readFileSync, readdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const moduleRoot = resolve(import.meta.dirname)

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|vue)$/.test(entry.name) ? [path] : []
  })
}

function importSpecifiers(source: string): string[] {
  const script = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)
  const imports: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ) imports.push(node.moduleSpecifier.text)
    if (
      ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
    ) imports.push(node.arguments[0].text)
    ts.forEachChild(node, visit)
  }
  visit(script)
  return imports
}

describe('plugin-shell ownership boundary', () => {
  it('keeps relative imports inside the plugin-shell module', () => {
    for (const path of sourceFiles(moduleRoot)) {
      for (const specifier of importSpecifiers(readFileSync(path, 'utf8'))) {
        if (!specifier.startsWith('.')) continue
        const target = resolve(dirname(path), specifier)
        expect(
          target === moduleRoot || target.startsWith(`${moduleRoot}${sep}`),
          `${relative(moduleRoot, path)}: ${specifier}`,
        ).toBe(true)
      }
    }
  })
})
