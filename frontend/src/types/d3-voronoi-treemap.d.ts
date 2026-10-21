declare module 'd3-voronoi-treemap' {
  import type { HierarchyNode } from 'd3'

  interface VoronoiTreemapLayout<Datum> {
    /** 执行布局，修改 hierarchy 节点，添加 polygon 属性 */
    (root: HierarchyNode<Datum>): void
    /** 设置外轮廓裁切多边形（[x,y][] 顺时针） */
    clip(): [number, number][]
    clip(polygon: [number, number][]): this
    /** 设置随机种子函数（用 seedrandom 固定布局） */
    prng(): () => number
    prng(fn: () => number): this
    /** 最大迭代次数，默认 50 */
    maxIterationCount(): number
    maxIterationCount(n: number): this
    /** 收敛误差阈值 */
    convergenceRatio(): number
    convergenceRatio(r: number): this
    /** 停止迭代时回调 */
    stopFunction(): ((totalIterationCount: number, layout: this) => boolean) | null
    stopFunction(fn: (totalIterationCount: number, layout: this) => boolean): this
  }

  /** 布局后每个节点带有的多边形信息 */
  interface VoronoiNode<Datum> extends HierarchyNode<Datum> {
    polygon: [number, number][] & { site?: { x: number; y: number } }
  }

  export function voronoiTreemap<Datum>(): VoronoiTreemapLayout<Datum>
}
