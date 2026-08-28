// Pure lane-assignment for a commit DAG, mirroring the approach used by
// lightweight git graph renderers. Commits are processed newest-first (the
// order `git log` returns). Each "lane" is a column that holds the hash of the
// commit it is currently waiting to draw. Lanes are never moved while active
// (only freed and later reused), so a lane index keeps a stable meaning and
// edges never need re-routing mid-life.
//
// Side-effect free + dependency free so it can be unit-tested directly.

export interface GraphCommit {
  hash: string
  parents: string[]
}

export interface GraphSegment {
  fromLane: number
  toLane: number
  half: 'top' | 'bottom' // top = incoming (above dot), bottom = outgoing (below dot)
}

export interface GraphRow {
  lane: number // column of this commit's dot
  color: string
  segments: GraphSegment[]
  laneCount: number // active lanes spanning this row (for width)
}

export interface GraphLayout {
  rows: GraphRow[]
  width: number // total columns needed
}

const PALETTE = [
  '#3fb950',
  '#58a6ff',
  '#bc8cff',
  '#f0883e',
  '#db61a2',
  '#56d4dd',
  '#e3b341',
  '#f85149',
]

export function laneColor(lane: number): string {
  return PALETTE[lane % PALETTE.length]
}

export function computeGraph(commits: GraphCommit[]): GraphLayout {
  const lanes: (string | null)[] = [] // lane index -> expected commit hash
  const rows: GraphRow[] = []

  const firstFree = (): number => lanes.indexOf(null)

  for (const c of commits) {
    const before = lanes.slice()

    // Locate (or create) the lane this commit lives in.
    let commitLane = before.indexOf(c.hash)
    if (commitLane === -1) {
      commitLane = firstFree()
      if (commitLane === -1) {
        commitLane = lanes.length
        lanes.push(null)
      }
    }

    const segments: GraphSegment[] = []

    // Upper half: every active incoming lane routes either to the dot (if it
    // was waiting for this commit) or straight down to itself.
    for (let l = 0; l < before.length; l++) {
      if (before[l] === null) continue
      segments.push({
        fromLane: l,
        toLane: before[l] === c.hash ? commitLane : l,
        half: 'top',
      })
    }

    // Free every lane that was waiting for this commit (merge convergence).
    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] === c.hash) lanes[l] = null
    }

    // Place parents: first parent keeps the commit's lane; extra parents reuse
    // an existing lane already waiting for them, else take a free/new lane.
    const parentLanes: number[] = []
    c.parents.forEach((p, idx) => {
      if (idx === 0) {
        lanes[commitLane] = p
        parentLanes.push(commitLane)
        return
      }
      let pl = lanes.indexOf(p)
      if (pl === -1) {
        pl = lanes.indexOf(null)
        if (pl === -1) {
          pl = lanes.length
          lanes.push(null)
        }
        lanes[pl] = p
      }
      parentLanes.push(pl)
    })

    // Lower half: every parent connects from the dot to its lane — a vertical
    // for the first parent (same lane) and a diagonal for each branch/merge
    // parent. Every OTHER active lane is an unrelated pass-through and falls
    // straight down. A parent lane is drawn ONLY via its diagonal here; drawing
    // a vertical for it too would leave a stray stub (the lane has nothing above
    // it on a fresh branch-out), which reads as a spurious fork.
    for (const pl of parentLanes) {
      segments.push({ fromLane: commitLane, toLane: pl, half: 'bottom' })
    }
    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] === null || l === commitLane || parentLanes.includes(l)) continue
      segments.push({ fromLane: l, toLane: l, half: 'bottom' })
    }

    const laneCount = Math.max(before.length, lanes.length)
    rows.push({ lane: commitLane, color: laneColor(commitLane), segments, laneCount })
  }

  const width = rows.reduce((m, r) => Math.max(m, r.laneCount), 1)
  return { rows, width }
}
