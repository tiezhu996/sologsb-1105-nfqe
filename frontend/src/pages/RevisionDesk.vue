<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRevisionStore } from '../stores/revisionStore'
import type { RevisionIssue } from '../types/revision'
import { REVISION_DIRECTIONS } from '../utils/revision'

const revisionStore = useRevisionStore()

const SAMPLE_TEXT = `# 兄弟馆离线编目修订表（示例：可整段复制到待确认区）
批次号: B-2026-1001

【图幅】
图幅号: 北平-甲-3|版本: 2|题名: 正阳门至崇文门街巷图（民国改绘版）|年代: 1928|比例尺: 1:5000|投影: 三角测量 · 平面图|尺寸: 58 × 46 厘米|图组: 京师实测图|状态: 已编
图幅号: 北平-乙-3|版本: 2|题名: 东单至朝阳门内街巷图（内外城合校版）|年代: 1928|比例尺: 1:5000|投影: 三角测量 · 平面图|尺寸: 58 × 46 厘米|图组: 京师实测图|状态: 已编
图幅号: 北平-甲-2|版本: 1|题名: 中华门至天安门皇城图|年代: 1928|比例尺: 1:5000|投影: 三角测量 · 平面图|尺寸: 58 × 46 厘米|图组: 京师实测图|状态: 待编

【扫描件】
图幅号: 北平-甲-3|版本: 2|文件名: 北平甲3_改绘版_600dpi.tif|分辨率: 600|色彩模式: 彩色|分块数: 4|图像质量: 清晰|存放位置: 市档案馆 D-17-04 铁柜|主用件: 是
图幅号: 北平-甲-3|版本: 2|文件名: 北平甲3_改绘晒蓝.jpg|分辨率: 300|色彩模式: 黑白|分块数: 2|图像质量: 偏淡|存放位置: 研究室地图柜 3-2|主用件: 否
图幅号: 北平-乙-3|版本: 2|文件名: 北平乙3_合校版_600dpi.tif|分辨率: 600|色彩模式: 灰度|分块数: 6|图像质量: 清晰|存放位置: 数字地图库 A-1928-07|主用件: 是
图幅号: 北平-甲-2|版本: 1|文件名: 北平甲2_皇城南部_600dpi.tif|分辨率: 600|色彩模式: 彩色|分块数: 4|图像质量: 清晰|存放位置: 数字地图库 A-1928-03|主用件: 是

【四至】
图幅号: 北平-甲-3|版本: 2|方向: 北|邻接图号: 北平-甲-2|邻接版本: 1
图幅号: 北平-甲-3|版本: 2|方向: 东|邻接图号: 北平-乙-3|邻接版本: 2
图幅号: 北平-甲-3|版本: 2|方向: 南|邻接图号: 保定-中-4|邻接版本: 1
图幅号: 北平-乙-3|版本: 2|方向: 西|邻接图号: 北平-甲-3|邻接版本: 2
图幅号: 北平-乙-3|版本: 2|方向: 南|邻接图号: 北平-丙-5|邻接版本: 1
图幅号: 北平-甲-2|版本: 1|方向: 南|邻接图号: 北平-甲-3|邻接版本: 2
`

const conflictSample = `# 含缺口与版本冲突的示例（对账不通过，无法提交）
批次号: B-2026-1002

【图幅】
图幅号: 北平-乙-3|版本: 2|题名: 东单至朝阳门内街巷图（内外城合校版）|年代: 1928|比例尺: 1:5000|投影: 三角测量 · 平面图|尺寸: 58 × 46 厘米|图组: 京师实测图|状态: 待核

【扫描件】
图幅号: 北平-乙-3|版本: 1|文件名: 北平乙3_仍指向旧图.tif|分辨率: 600|色彩模式: 灰度|分块数: 6|图像质量: 清晰|存放位置: 临时箱 R-01|主用件: 是

【四至】
图幅号: 北平-乙-3|版本: 2|方向: 东|邻接图号: 北平-乙-4|邻接版本: 1
图幅号: 北平-乙-3|版本: 2|方向: 西|邻接图号: 北平-甲-3|邻接版本: 2
`

const report = computed(() => revisionStore.report)
const analyzing = ref(false)
const justCommitted = ref(false)

async function runAnalyze(): Promise<void> {
  analyzing.value = true
  try {
    await revisionStore.analyze()
    justCommitted.value = false
  } finally {
    analyzing.value = false
  }
}

async function runCommit(): Promise<void> {
  const ok = await revisionStore.commit()
  if (ok) {
    justCommitted.value = true
  }
}

function useSample(text: string): void {
  revisionStore.saveDraft(text)
  revisionStore.report = null
  revisionStore.applyError = ''
  justCommitted.value = false
}

function issueTagType(issue: RevisionIssue): 'danger' | 'warning' {
  return issue.level === 'error' ? 'danger' : 'warning'
}

function issueLabel(issue: RevisionIssue): string {
  if (issue.kind === 'gap') {
    return '缺口'
  }
  if (issue.kind === 'version') {
    return '版本'
  }
  if (issue.kind === 'duplicate') {
    return '重号'
  }
  if (issue.kind === 'enum') {
    return '取值'
  }
  return '解析'
}

function formatAppliedAt(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function directionText(directions: string[]): string {
  return REVISION_DIRECTIONS.filter((direction) => directions.includes(direction)).join('、') || '—'
}

onMounted(async () => {
  await revisionStore.loadAppliedRevisions()
  // 暂存区有未处理完的修订表时，进入页面自动重新对账
  if (revisionStore.draftText.trim()) {
    await runAnalyze()
  }
})
</script>

<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <span class="page-kicker">OFFLINE REVISION RECONCILE</span>
        <h1>离线修订对账台</h1>
        <p>把兄弟馆带回的编目修订表贴入待确认区，按图幅号与图幅版本对账；图幅、扫描件、四至同版本落位后才整批写入。</p>
      </div>
    </div>

    <el-alert
      v-if="justCommitted"
      type="success"
      :closable="false"
      show-icon
      title="修订批次已确认写入，图幅列表、详情与邻接页现在读到的是已确认版本。"
      class="mb-16"
    />

    <div class="revision-layout">
      <div>
        <div class="section-title">
          <div>
            <h2>待确认区</h2>
            <span class="muted">修订表暂存于本机，应用失败或刷新页面都不会丢失。</span>
          </div>
          <div>
            <el-button size="small" @click="useSample(SAMPLE_TEXT)">填入可通过示例</el-button>
            <el-button size="small" @click="useSample(conflictSample)">填入冲突示例</el-button>
          </div>
        </div>

        <el-input
          :model-value="revisionStore.draftText"
          type="textarea"
          :rows="18"
          spellcheck="false"
          data-testid="revision-textarea"
          placeholder="批次号: B-…&#10;&#10;【图幅】&#10;图幅号: …|版本: 2|题名: …|年代: …|比例尺: 1:5000|投影: …|尺寸: …|图组: …|状态: …&#10;&#10;【扫描件】&#10;图幅号: …|版本: 2|文件名: …|分辨率: 600|色彩模式: 彩色|分块数: 4|图像质量: 清晰|存放位置: …|主用件: 是&#10;&#10;【四至】&#10;图幅号: …|版本: 2|方向: 东|邻接图号: …|邻接版本: 2"
          @update:model-value="revisionStore.saveDraft($event)"
        />

        <div class="revision-actions">
          <el-button
            type="primary"
            :loading="analyzing"
            data-testid="revision-analyze"
            @click="runAnalyze"
          >
            按图幅号与版本对账
          </el-button>
          <el-button
            type="success"
            :disabled="!revisionStore.canCommit"
            :loading="revisionStore.applying"
            data-testid="revision-commit"
            @click="runCommit"
          >
            确认写入整批修订
          </el-button>
          <el-button
            :disabled="!revisionStore.draftText && !report"
            data-testid="revision-clear"
            @click="revisionStore.clearDraft(); justCommitted = false"
          >
            清空待确认区
          </el-button>
        </div>
        <p v-if="revisionStore.applyError" class="text-danger" data-testid="revision-apply-error">
          写入失败（暂存仍保留，可处理后重试）：{{ revisionStore.applyError }}
        </p>

        <template v-if="report">
          <el-alert
            v-if="report.alreadyApplied"
            type="info"
            :closable="false"
            show-icon
            class="mb-16"
            :title="`同一批资料已于 ${formatAppliedAt(report.appliedAt ?? '')} 应用，沿用上一次结果，不再重复写入。`"
          />
          <el-alert
            v-else-if="report.errors.length"
            type="error"
            :closable="false"
            show-icon
            class="mb-16"
            :title="`对账发现 ${report.errors.length} 处阻断问题（缺口或版本冲突），处理后重新对账方可提交。`"
          />
          <el-alert
            v-else
            type="success"
            :closable="false"
            show-icon
            class="mb-16"
            title="图幅、扫描件、四至均可落到同一版本，可以整批写入。"
          />

          <div class="metrics-strip">
            <div class="metric">
              <span>批次图幅</span>
              <strong>{{ report.sheetPreviews.length }}</strong><small>幅</small>
            </div>
            <div class="metric">
              <span>批次扫描件</span>
              <strong>{{ report.scanPreviews.length }}</strong><small>件</small>
            </div>
            <div class="metric">
              <span>四至关系</span>
              <strong>{{ report.edgePreviews.length }}</strong><small>条</small>
            </div>
          </div>

          <section v-if="report.issues.length" class="side-panel mb-16">
            <h2>对账问题清单</h2>
            <ul class="issue-list">
              <li v-for="(item, index) in report.issues" :key="'issue-' + index" class="issue-list__item">
                <el-tag :type="issueTagType(item)" size="small" effect="dark">{{ issueLabel(item) }}</el-tag>
                <span>{{ item.message }}</span>
                <span v-if="item.lineNo" class="muted">（第 {{ item.lineNo }} 行）</span>
              </li>
            </ul>
          </section>

          <section class="side-panel mb-16">
            <h2>图幅落位预览</h2>
            <table class="revision-table">
              <thead>
                <tr>
                  <th>图幅号</th><th>版本</th><th>动作</th><th>题名</th><th>扫描件</th><th>四至方向</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="preview in report.sheetPreviews" :key="preview.code">
                  <td>{{ preview.code }}</td>
                  <td>
                    <el-tag size="small" type="info" effect="plain">v{{ preview.localVersion ?? '—' }}</el-tag>
                    <span class="muted"> → </span>
                    <el-tag size="small" type="success" effect="dark">v{{ preview.version }}</el-tag>
                  </td>
                  <td>
                    <el-tag size="small" :type="preview.action === 'replace' ? 'warning' : 'primary'">
                      {{ preview.action === 'replace' ? '升版替换' : '新增' }}
                    </el-tag>
                  </td>
                  <td>{{ preview.title }}（{{ preview.year }}）</td>
                  <td>{{ preview.scanCount }} 件</td>
                  <td>{{ directionText(preview.neighborDirections) }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="side-panel mb-16">
            <h2>四至落位预览</h2>
            <table class="revision-table">
              <thead>
                <tr>
                  <th>本图（版本）</th><th>方向</th><th>邻接图（版本）</th><th>邻图来源</th><th>反向镜像</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(edge, index) in report.edgePreviews" :key="'edge-' + index">
                  <td>{{ edge.fromCode }} <el-tag size="small">v{{ edge.fromVersion }}</el-tag></td>
                  <td>{{ edge.direction }}</td>
                  <td>{{ edge.toCode }} <el-tag size="small">v{{ edge.toVersion }}</el-tag></td>
                  <td>{{ edge.targetAction === 'batch' ? '本批次' : '本地馆藏' }}</td>
                  <td>
                    <span v-if="edge.mirrored" class="moss-text">已补对向</span>
                    <span v-else-if="edge.mirroredNote" class="text-warning">{{ edge.mirroredNote }}</span>
                    <span v-else class="muted">—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </template>
      </div>

      <aside>
        <section class="side-panel">
          <h2>对账规则</h2>
          <ul class="rule-list">
            <li>重号图幅必须以<strong>更高版本</strong>替换，同版或旧版直接判版本冲突。</li>
            <li>扫描件只能挂到本批次<strong>同版本图幅</strong>，升版图幅的旧扫描件整组撤下。</li>
            <li>四至两端必须版本对得上；邻图不在批次内须用「图号@版本」标明。</li>
            <li>馆藏缺口、版本冲突未处理前，确认写入按钮不可用。</li>
            <li>写入为整批原子操作；失败可重试，待确认区暂存保留。</li>
            <li>同一批资料再次导入，沿用上一次应用结果，不重复落账。</li>
          </ul>
        </section>

        <section class="side-panel">
          <h2>已应用批次</h2>
          <p v-if="revisionStore.appliedRevisions.length === 0" class="muted">尚无成功应用的离线修订批次。</p>
          <ul class="applied-list">
            <li v-for="applied in revisionStore.appliedRevisions" :key="applied.id">
              <div>
                <strong>{{ applied.batchId }}</strong>
                <span class="muted">{{ formatAppliedAt(applied.appliedAt) }}</span>
              </div>
              <small class="muted">
                {{ applied.sheetCount }} 幅 · {{ applied.scanCount }} 扫描件 · {{ applied.edgeCount }} 四至
              </small>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </section>
</template>
