import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  DOC_SUFFIXES,
  MAX_DIRECTORY_ENTRIES,
  MAX_NESTED_CANDIDATES,
  MAX_NESTED_ROOT_DEPTH,
  MAX_NESTED_ROOTS,
  NOISE_SEGMENTS,
  PLAN_DOC_DIRS,
  TRAVERSAL_SORT_ORDER,
} from "../../src/main/plugins/plansDirectories"

interface PlanDocumentLocationsFixture {
  schemaVersion: number
  directoryInventory: string[]
  supportedExtensions: string[]
  maxNestedDepth: number
  maxNestedRoots: number
  maxDirectoryEntries: number
  maxNestedCandidates: number
  traversalSortOrder: string
  noiseSegments: string[]
}

describe("Plan Document Locations Fixture Parity", () => {
  const fixturePath = join(process.cwd(), "docs/plugin-contracts/plan-document-locations-v1.json")
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as PlanDocumentLocationsFixture

  it("validates schemaVersion is 1", () => {
    expect(fixture.schemaVersion).toBe(1)
  })

  it("asserts TypeScript Host directoryInventory matches fixture with 7 items", () => {
    expect([...PLAN_DOC_DIRS]).toEqual(fixture.directoryInventory)
    expect(PLAN_DOC_DIRS).toHaveLength(7)
    expect(new Set(PLAN_DOC_DIRS).size).toBe(PLAN_DOC_DIRS.length)
  })

  it("asserts TypeScript Host supportedExtensions matches fixture", () => {
    expect([...DOC_SUFFIXES]).toEqual(fixture.supportedExtensions)
    expect(DOC_SUFFIXES).toHaveLength(3)
  })

  it("asserts TypeScript Host maxNestedDepth and maxNestedRoots match fixture", () => {
    expect(MAX_NESTED_ROOT_DEPTH).toBe(fixture.maxNestedDepth)
    expect(MAX_NESTED_ROOT_DEPTH).toBe(2)
    expect(MAX_NESTED_ROOTS).toBe(fixture.maxNestedRoots)
    expect(MAX_NESTED_ROOTS).toBe(50)
  })

  it("asserts TypeScript Host maxDirectoryEntries matches fixture", () => {
    expect(MAX_DIRECTORY_ENTRIES).toBe(fixture.maxDirectoryEntries)
    expect(MAX_DIRECTORY_ENTRIES).toBe(2000)
  })

  it("asserts the global nested candidate budget matches the fixture", () => {
    expect(MAX_NESTED_CANDIDATES).toBe(fixture.maxNestedCandidates)
    expect(MAX_NESTED_CANDIDATES).toBe(2000)
  })

  it("asserts TypeScript Host traversalSortOrder matches fixture", () => {
    expect(TRAVERSAL_SORT_ORDER).toBe(fixture.traversalSortOrder)
    expect(TRAVERSAL_SORT_ORDER).toBe("utf8_bytes_ascending")
  })

  it("asserts TypeScript Host noiseSegments matches fixture", () => {
    expect([...NOISE_SEGMENTS]).toEqual(fixture.noiseSegments)
    expect(NOISE_SEGMENTS).toHaveLength(17)
  })
})
