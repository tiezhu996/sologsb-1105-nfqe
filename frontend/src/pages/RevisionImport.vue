<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRevisionStore } from '../stores/revisionStore'
import { useSheetStore } from '../stores/sheetStore'

const revisionStore = useRevisionStore()
const sheetStore = useSheetStore()

const SAMPLE_REVISION = `图幅：北平-乙-3 版本：2
题名：东单至朝阳门内街巷图（实测修订）
年代：1935
比例尺：1:5000
投影：三角测量 · 平面图
图幅尺寸：58 × 46 厘米
图组：京师实测图
状态：待核

扫描件：北平-乙-3 版本：2
文件名：北平乙3_实测修订_600dpi.tif
分辨率：600
色彩模式：彩色
分块数：6
图像质量：清晰
存放位置：数字地图库 A-1935-09
主用件：是

四至：北平-乙-3 版本：2
西：北平-甲-3@1
南：北平-丙-5@1`

const localVersionMap = computed(() => new Map(sheetStore.sheets.map((sheet) => [sheet.code, sheet.version])))

async function onInput(event: Event): Promise<void> {
  const target = event.target
  if (target instanceof HTMLTextAreaElement) {
    await revisionStore.stageDraft(target.value)
  }
}

function loadSample(): void {
  void revisionStore.stageDraft(SAMPLE_REVISION)
}

async function submitBatch(): Promise<void> {
  await revisionStore.applyBatch()
}

async function clearDraft(): Promise<void> {
  await revisionStore.clearDraft()
}

const issueKindMeta = [
  { key: '缺口' as const, title: '馆藏缺口', tone: 'warning' },
  { key: '版本冲突' as const, title: '版本冲突 / 重号', tone: 'danger' },
  { key: '格式' as const, title: '修订表格式', tone: 'info' },
]

const affectedCodes = computed(() => revisionStore.batch?.sheetCodes ?? [])

const targetVersionMap = computed(() => {
  const map = new Map<string, number>()
  for (const block of revisionStore.batch?.blocks ?? []) {
    map.set(block.payload.code, block.payload.version)
  }
  return map
})

onMounted(() => {
  void Promise.all([sheetStore.init(), revisionStore.init()])
})
</script>

<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <span class="page-kicker">OFFLINE REVISION</span>
        <h1>离线修订对账台</h1>
        <p>把兄弟馆带回的编目修订表贴进待确认区，按图幅号与图幅版本对账；图幅、扫描件与四至关系同版本落位后再整批写入。</p>
      </div>
      <el-button size="large" @click="loadSample">填入示例修订表</el-button>
    </div>

    <div class="revision-layout">
      <div>
        <section class="inline-form revision-input">
          <div class="section-title">
            <div>
              <h2>待确认区</h2>
              <span class="muted">应用失败后可重试，文本会暂存在本机；处理完缺口与版本冲突再提交。</span>
            </div>
            <el-button link type="info" data-testid="clear-revision" @click="clearDraft">清空待确认区</el-button>
          </div>
          <textarea
            class="revision-textarea"
            data-testid="revision-input"
            placeholder="粘贴修订表文本，例如：&#10;图幅：北平-乙-3 版本：2&#10;题名：……&#10;年代：1935&#10;&#10;扫描件：北平-乙-3 版本：2&#10;文件名：……&#10;存放位置：……&#10;&#10;四至：北平-乙-3 版本：2&#10;西：北平-甲-3@1"
            :value="revisionStore.draftText"
            @input="onInput"
          ></textarea>
          <div class="revision-toolbar">
            <div class="revision-status" data-testid="revision-status">
              <template v-if="revisionStore.reusedRecord">
                <el-tag type="success" effect="dark">同一批资料已应用，沿用首次结果</el-tag>
              </template>
              <template v-else-if="revisionStore.batch">
                <el-tag :type="revisionStore.ready ? 'success' : 'danger'" effect="dark" data-testid="revision-ready">
                  {{ revisionStore.ready ? '版本一致，可以整批写入' : '存在未处理的缺口或版本冲突' }}
                </el-tag>
                <span class="muted">
                  涉及图幅 {{ affectedCodes.length }} 幅 · 扫描件 {{ revisionStore.batch.scanCount }} 件 ·
                  四至 {{ revisionStore.batch.relationCount }} 组
                </span>
              </template>
              <span v-else-if="!revisionStore.draftText" class="muted">尚未粘贴修订表文本。</span>
            </div>
            <el-button
              type="primary"
              size="large"
              data-testid="apply-revision"
              :loading="revisionStore.applying"
              :disabled="!revisionStore.ready || Boolean(revisionStore.reusedRecord)"
              @click="submitBatch"
            >
              整批写入
            </el-button>
          </div>
          <p v-if="revisionStore.applyError" class="text-danger" data-testid="revision-error">
            {{ revisionStore.applyError }}
          </p>
          <p v-if="revisionStore.reusedRecord" class="muted" data-testid="revision-reused">
            该批次已于 {{ new Date(revisionStore.reusedRecord.appliedAt).toLocaleString('zh-CN') }}
            写入，涉及 {{ revisionStore.reusedRecord.sheetCodes.join('、') }}，本次导入不重复写库。
          </p>
        </section>

        <section v-if="revisionStore.batch" class="revision-findings">
          <h2>对账结果</h2>
          <div v-for="group in issueKindMeta" :key="group.key" class="finding-group">
            <div class="finding-group__head">
              <el-tag :type="group.tone === 'danger' ? 'danger' : group.tone === 'warning' ? 'warning' : 'info'" effect="dark">
                {{ group.title }}
              </el-tag>
              <strong>{{ revisionStore.issueGroups[group.key].length }}</strong>
              <span class="muted">项</span>
            </div>
            <ul v-if="revisionStore.issueGroups[group.key].length" class="finding-list">
              <li v-for="(item, index) in revisionStore.issueGroups[group.key]" :key="`${group.key}-${index}`">
                <span class="finding-list__code">{{ item.code }}</span>
                <span class="finding-list__subject">{{ item.subject }}</span>
                <span>{{ item.message }}</span>
              </li>
            </ul>
            <p v-else class="muted finding-empty">本项没有问题。</p>
          </div>

          <div v-if="revisionStore.ready" class="revision-preview" data-testid="revision-preview">
            <h3>写入后确认版本预览</h3>
            <ul>
              <li v-for="code in affectedCodes" :key="code">
                <strong>{{ code }}</strong>
                <span>
                  将确认为版本 v{{ targetVersionMap.get(code) }}
                  <template v-if="localVersionMap.get(code)">（本地原为 v{{ localVersionMap.get(code) }}）</template>
                  <template v-else>（新入藏）</template>
                </span>
              </li>
            </ul>
          </div>
        </section>
      </div>

      <aside>
        <section class="side-panel">
          <h2>本批图幅</h2>
          <ul v-if="affectedCodes.length" class="revision-code-list">
            <li v-for="code in affectedCodes" :key="code">
              <strong>{{ code }}</strong>
              <small>本地版本 v{{ localVersionMap.get(code) ?? '—' }}</small>
            </li>
          </ul>
          <p v-else class="muted">待确认区为空。</p>
        </section>

        <section class="side-panel">
          <h2>已应用批次</h2>
          <p class="muted">同一批资料再次导入时，按文本内容命中这些留档并沿用首次结果。</p>
          <ul v-if="revisionStore.appliedRecords.length" class="revision-record-list">
            <li v-for="record in revisionStore.appliedRecords" :key="record.id">
              <div>
                <el-tag type="success" effect="dark">{{ record.status }}</el-tag>
                <small>{{ new Date(record.appliedAt).toLocaleString('zh-CN') }}</small>
              </div>
              <p>{{ record.sheetCodes.join('、') }}</p>
              <small class="muted">
                图幅 {{ record.sheetCount }} 幅 · 扫描件 {{ record.scanCount }} 件 · 四至 {{ record.relationCount }} 组
              </small>
            </li>
          </ul>
          <p v-else class="muted">还没有成功应用的批次。</p>
        </section>

        <section class="side-panel">
          <h2>修订表格式</h2>
          <p class="muted">
            分块首行写 <strong>图幅：图号 版本：2</strong>、<strong>扫描件：图号 版本：2</strong>、<strong>四至：图号
              版本：2</strong>，块内每行“字段：值”，空行分块。四至可写 <strong>图号@版本</strong>
            指向具体版本；省略版本时按本批次或本地图幅自动核对。
          </p>
        </section>
      </aside>
    </div>
  </section>
</template>
