import { CodeRenderable, MarkdownRenderable, RGBA, SyntaxStyle } from "@opentui/core"
import { createTestRenderer, MockTreeSitterClient } from "@opentui/core/testing"
import { createMermaidMarkdownRenderer } from "../markdown.js"

async function renderFrames(sources: string[], streaming = false): Promise<string[]> {
  const test = await createTestRenderer({ width: 80, height: 40 })
  const style = SyntaxStyle.fromStyles({ default: { fg: RGBA.fromValues(1, 1, 1, 1) } }, test.renderer.nativeScene)
  const tree = new MockTreeSitterClient({ autoResolveTimeout: 0 })
  const fence = (source: string) => ["Before", "", "```mermaid", source, "```", "", "After"].join("\n")
  try {
    const markdown = new MarkdownRenderable(test.renderer, {
      id: "subgraph-cycles",
      content: fence(sources[0]!),
      syntaxStyle: style,
      treeSitterClient: tree,
      renderNode: createMermaidMarkdownRenderer(test.renderer),
      streaming,
      internalBlockMode: "top-level",
    })
    test.renderer.root.add(markdown)
    const capture = async () => {
      await test.renderOnce()
      const children = [...markdown.getChildren()]
      while (children.length) {
        const child = children.pop()!
        if (child instanceof CodeRenderable && child.isHighlighting) await child.highlightingDone
        children.push(...child.getChildren())
      }
      await test.renderOnce()
      return test.captureCharFrame()
    }
    const frames: string[] = []
    for (const source of sources) {
      markdown.content = fence(source)
      frames.push(await capture())
    }
    if (streaming) {
      markdown.streaming = false
      frames.push(await capture())
    }
    return frames
  } finally {
    test.renderer.destroy()
    await test.renderer.closed
    style.destroy()
    await tree.destroy()
  }
}

const sources = [
  `flowchart TD
subgraph A
subgraph A
N[First]
end
end`,
  `flowchart TD
subgraph A
subgraph B
N[First]
end
end
subgraph B
subgraph A
M[Second]
end
end`,
]
sources.push(sources[0]! + "\nC -->")
const fresh = []
for (const source of sources) fresh.push({ source, frame: (await renderFrames([source]))[0]! })
const acyclic = (
  await renderFrames([
    `flowchart LR
subgraph A
X[First]
end
subgraph A
Y[Second]
end`,
  ])
)[0]!
const initial = "flowchart TD\nsubgraph A\nX[Earlier]\nend"
const incomplete = "flowchart TD\nsubgraph A\nX[Earlier]\nsubgraph A\nY[Later]"
const complete = incomplete + "\nend\nend"
console.log(
  JSON.stringify({
    fresh,
    acyclic,
    streamed: { source: complete, frames: await renderFrames([initial, incomplete, complete], true) },
  }),
)
