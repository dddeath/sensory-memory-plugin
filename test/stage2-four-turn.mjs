import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DemotionEngine, ExtractionEngine, IndexSourceStore, MatchEngine, SensoryIndex } from '../lib/index.js'

const path = mkdtempSync(join(tmpdir(), 'sensory-stage2-4turn-'))
try {
  const index = new SensoryIndex(path)
  const matcher = new MatchEngine(index)
  const demoter = new DemotionEngine({ index, extractor: new ExtractionEngine(), sourceStore: new IndexSourceStore(index), matcher })
  await demoter.onTurnEnd({ turn: 1, sessionId: 'four-turn', queryText: '执行部署检查', messages: [
    { sourceSeq: 4001, role: 'tool', kind: 'tool', toolName: 'shell', text: 'RESULT: 项目A的部署端口是8081。' },
  ] })
  for (let turn = 2; turn <= 4; turn += 1) {
    await demoter.onTurnEnd({ turn, sessionId: 'four-turn', queryText: `无关话题${turn}`, messages: [] })
  }
  const rounds = JSON.parse(readFileSync(join(path, 'rounds.json'), 'utf8'))
  const tool = rounds.tracked.find((item) => item.kind === 'tool')
  const match = await matcher.match('项目A部署在哪个端口')
  const output = {
    turns: 4,
    toolDemoted: tool?.demoted === true,
    toolUnrefCount: tool?.unrefCount,
    entityCount: index.count(),
    top1: match.engrams[0]?.name ?? null,
    sourceStored: index.readSource({ sessionId: 'four-turn', seq: 4001 })?.text ?? null,
  }
  console.log(JSON.stringify(output))
  if (!output.toolDemoted || output.toolUnrefCount !== 3 || output.top1 !== '项目A') process.exitCode = 1
} finally {
  rmSync(path, { recursive: true, force: true })
}
