export interface MockExchange {
  id: string;
  question: string;
  answer: string;
  time: string;
}

// M1 专用模拟数据。结构与 M4 的 Exchange 视图模型对齐，便于平滑替换。
export const mockExchanges: MockExchange[] = [
  {
    id: "1",
    question: "如何用一句话解释量子纠缠？",
    answer:
      "量子纠缠是指两个或多个粒子生成或相互作用后，各粒子拥有的量子态无法单独描述，只能描述整体系统的量子态，即使彼此相隔很远，测量一个也会瞬间影响另一个的测量结果。",
    time: "今天 14:32",
  },
  {
    id: "2",
    question: "帮我写一个 TypeScript 防抖函数",
    answer:
      "下面是一个带取消功能的防抖实现：\n\n```ts\nfunction debounce<T extends (...a: any[]) => void>(fn: T, ms: number) {\n  let t: ReturnType<typeof setTimeout>;\n  return (...args: Parameters<T>) => {\n    clearTimeout(t);\n    t = setTimeout(() => fn(...args), ms);\n  };\n}\n```\n\n调用 `debounce(save, 300)` 即可得到 300ms 防抖版本。",
    time: "今天 11:08",
  },
  {
    id: "3",
    question: "苹果风格界面设计的几个关键原则",
    answer:
      "1. 层次清晰：用毛玻璃与微妙的阴影区分层级，而非粗重边框。\n2. 留白充足：内容之间保持呼吸感。\n3. 动效克制：使用简短的缓动过渡，反馈明确但不夸张。\n4. 语义化颜色：强调色只用于可交互元素。",
    time: "昨天 20:47",
  },
  {
    id: "4",
    question: "读一本好书和刷短视频的区别",
    answer:
      "两者本质上是不同的信息处理方式：读书是主动构建，需要持续注意力与想象参与；短视频是被动接收，靠高频刺激维持注意力。长期看，前者更可能形成结构化认知，后者更容易形成碎片化记忆。",
    time: "昨天 09:15",
  },
];
