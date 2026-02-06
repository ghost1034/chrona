import { useEffect, useMemo, useState } from 'react'
import { formatBytes } from '../shared/format'
import type { CategoryDefinition, SubcategoryDefinition } from '../shared/categories'

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'] as const

type DisplayInfo = { id: string; bounds: { width: number; height: number }; scaleFactor: number }

export function SettingsView(props: {
  statusLine: string
  recording: boolean
  systemPaused: boolean
  lastError: string | null

  onToggleRecording: () => Promise<void>

  interval: number | null
  setInterval: (n: number | null) => void
  onSaveInterval: () => Promise<void>

  displays: DisplayInfo[]
  selectedDisplayId: string | null
  onSelectDisplay: (id: string) => Promise<void>

  analysisLine: string
  onRunAnalysisTick: () => Promise<void>

  analysisCheckIntervalSeconds: string
  setAnalysisCheckIntervalSeconds: (s: string) => void
  analysisLookbackSeconds: string
  setAnalysisLookbackSeconds: (s: string) => void
  analysisBatchTargetMinutes: string
  setAnalysisBatchTargetMinutes: (s: string) => void
  analysisBatchMaxGapMinutes: string
  setAnalysisBatchMaxGapMinutes: (s: string) => void
  analysisMinBatchMinutes: string
  setAnalysisMinBatchMinutes: (s: string) => void
  analysisCardWindowMinutes: string
  setAnalysisCardWindowMinutes: (s: string) => void
  onApplyAnalysisPreset: (presetId: string) => void
  onSaveAnalysisConfig: () => Promise<void>

  storageUsage: {
    recordingsBytes: number
    timelapsesBytes: number
    recordingsLimitBytes: number
    timelapsesLimitBytes: number
  } | null
  limitRecordingsGb: string
  setLimitRecordingsGb: (s: string) => void
  limitTimelapsesGb: string
  setLimitTimelapsesGb: (s: string) => void
  onSaveStorageLimits: () => Promise<void>
  onPurgeNow: () => Promise<void>

  timelapsesEnabled: boolean
  onToggleTimelapsesEnabled: (enabled: boolean) => Promise<void>
  timelapseFps: number
  setTimelapseFps: (n: number) => void
  onSaveTimelapseFps: () => Promise<void>

  autoStartEnabled: boolean
  onToggleAutoStartEnabled: (enabled: boolean) => Promise<void>

  hasGeminiKey: boolean | null
  geminiKeyInput: string
  setGeminiKeyInput: (s: string) => void
  onSaveGeminiKey: () => Promise<void>

  geminiModel: string
  setGeminiModel: (s: string) => void
  geminiRequestTimeoutMs: number
  setGeminiRequestTimeoutMs: (n: number) => void
  geminiMaxAttempts: number
  setGeminiMaxAttempts: (n: number) => void
  geminiLogBodies: boolean
  setGeminiLogBodies: (b: boolean) => void
  onSaveGeminiRuntime: () => Promise<void>

  promptPreambleTranscribe: string
  setPromptPreambleTranscribe: (s: string) => void
  promptPreambleCards: string
  setPromptPreambleCards: (s: string) => void
  promptPreambleAsk: string
  setPromptPreambleAsk: (s: string) => void
  promptPreambleJournalDraft: string
  setPromptPreambleJournalDraft: (s: string) => void
  onSavePromptPreambles: () => Promise<void>

  categories: CategoryDefinition[]
  subcategories: SubcategoryDefinition[]
  onRefreshCategories: () => Promise<void>
  onCreateCategory: (input: { name: string; color: string; description: string }) => Promise<void>
  onUpdateCategory: (input: {
    id: string
    patch: Partial<{ name: string; color: string; description: string }>
  }) => Promise<void>
  onDeleteCategory: (input: { id: string; reassignToCategoryId: string }) => Promise<void>
  onCreateSubcategory: (input: {
    categoryId: string
    name: string
    color: string
    description: string
  }) => Promise<void>
  onUpdateSubcategory: (input: {
    id: string
    patch: Partial<{ name: string; color: string; description: string }>
  }) => Promise<void>
  onDeleteSubcategory: (
    input: { id: string; mode: 'clear' } | { id: string; mode: 'reassign'; reassignToSubcategoryId: string }
  ) => Promise<void>
}) {
  const sections = useMemo(
    () => [
      { id: 'capture', label: 'Capture' },
      { id: 'timeline', label: 'Timeline' },
      { id: 'analysis', label: 'Analysis' },
      { id: 'ai', label: 'AI (Gemini)' },
      { id: 'prompts', label: 'Prompts' },
      { id: 'storage', label: 'Storage' },
      { id: 'app', label: 'App' }
    ],
    []
  )

  const [active, setActive] = useState<string>('capture')

  const [catErr, setCatErr] = useState<string | null>(null)
  const [catBusy, setCatBusy] = useState<boolean>(false)

  const [newCatName, setNewCatName] = useState<string>('')
  const [newCatColor, setNewCatColor] = useState<string>('#3BD4B2')
  const [newCatDescription, setNewCatDescription] = useState<string>('')

  const orderedCategories = useMemo(() => {
    return [...props.categories].sort(
      (a, b) => (Number(a.order ?? 0) || 0) - (Number(b.order ?? 0) || 0)
    )
  }, [props.categories])

  const [categoryDrafts, setCategoryDrafts] = useState<
    Record<string, { name: string; color: string; description: string }>
  >({})

  const [subcategoryDrafts, setSubcategoryDrafts] = useState<
    Record<string, { name: string; color: string; description: string }>
  >({})

  const [activeCategoryId, setActiveCategoryId] = useState<string>(() => {
    const first = orderedCategories[0]
    return first?.id ?? ''
  })

  useEffect(() => {
    if (active !== 'timeline') return
    const has = orderedCategories.some((c) => c.id === activeCategoryId)
    if (!has) setActiveCategoryId(orderedCategories[0]?.id ?? '')
  }, [active, activeCategoryId, orderedCategories])

  useEffect(() => {
    if (active !== 'timeline') return
    setCategoryDrafts((prev) => {
      const next = { ...prev }
      for (const c of orderedCategories) {
        if (!next[c.id]) next[c.id] = { name: c.name, color: c.color, description: c.description }
      }
      return next
    })
  }, [active, orderedCategories])

  const subcategoriesForActive = useMemo(() => {
    const list = props.subcategories.filter((s) => s.categoryId === activeCategoryId)
    list.sort((a, b) => (Number(a.order ?? 0) || 0) - (Number(b.order ?? 0) || 0))
    return list
  }, [props.subcategories, activeCategoryId])

  useEffect(() => {
    if (active !== 'timeline') return
    setSubcategoryDrafts((prev) => {
      const next = { ...prev }
      for (const s of props.subcategories) {
        if (!next[s.id]) next[s.id] = { name: s.name, color: s.color, description: s.description }
      }
      return next
    })
  }, [active, props.subcategories])

  const [newSubName, setNewSubName] = useState<string>('')
  const [newSubColor, setNewSubColor] = useState<string>('#9AA4B2')
  const [newSubDescription, setNewSubDescription] = useState<string>('')

  const [pendingDeleteCategoryId, setPendingDeleteCategoryId] = useState<string | null>(null)
  const [pendingDeleteCategoryReassignId, setPendingDeleteCategoryReassignId] = useState<string>('')

  const [pendingDeleteSubId, setPendingDeleteSubId] = useState<string | null>(null)
  const [pendingDeleteSubMode, setPendingDeleteSubMode] = useState<'clear' | 'reassign'>('clear')
  const [pendingDeleteSubReassignId, setPendingDeleteSubReassignId] = useState<string>('')

  return (
    <div className="settingsWrap">
      <div className="settingsNav">
        <div className="settingsNavTitle">Settings</div>
        {sections.map((s) => (
          <button
            key={s.id}
            className={`settingsNavItem ${active === s.id ? 'active' : ''}`}
            onClick={() => setActive(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="settingsBody">
        {active === 'capture' ? (
          <div className="settingsSection">
            <div className="sideTitle">Capture</div>
            <div className="sideMeta">{props.statusLine}</div>

            <div className="row">
              <button className="btn btn-accent" onClick={() => void props.onToggleRecording()}>
                {props.recording ? 'Stop recording' : 'Start recording'}
              </button>
              {props.systemPaused ? <div className="pill">System paused (sleep/lock)</div> : null}
            </div>

            {props.lastError ? (
              <div className="row">
                <div className="mono error">Last capture error: {props.lastError}</div>
              </div>
            ) : null}

            <div className="block">
              <div className="sideTitle">Interval</div>
              <div className="row">
                <label className="label">
                  Interval (seconds)
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={props.interval ?? ''}
                    onChange={(e) => props.setInterval(e.target.value ? Number(e.target.value) : null)}
                  />
                </label>
                <button className="btn" onClick={() => void props.onSaveInterval()}>
                  Save
                </button>
              </div>
            </div>

            <div className="block">
              <div className="sideTitle">Display</div>
              <div className="row">
                <label className="label">
                  Capture display
                  <select
                    className="input"
                    value={props.selectedDisplayId ?? 'auto'}
                    onChange={(e) => void props.onSelectDisplay(e.target.value)}
                  >
                    <option value="auto">Auto (cursor)</option>
                    {props.displays.map((d) => (
                      <option key={d.id} value={d.id}>
                        Display {d.id} ({d.bounds.width}x{d.bounds.height} @ {d.scaleFactor}x)
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          </div>
        ) : null}

        {active === 'timeline' ? (
          <div className="settingsSection">
            <div className="sideTitle">Timeline categories</div>
            <div className="sideMeta">
              Create, edit, or delete categories and subcategories. Deletions require reassignment.
            </div>

            <div className="row">
              <button
                className="btn"
                onClick={() =>
                  void (async () => {
                    try {
                      setCatErr(null)
                      setCatBusy(true)
                      await props.onRefreshCategories()
                    } catch (e) {
                      setCatErr(e instanceof Error ? e.message : String(e))
                    } finally {
                      setCatBusy(false)
                    }
                  })()
                }
                disabled={catBusy}
              >
                Refresh
              </button>
              {catErr ? <div className="mono error">{catErr}</div> : null}
            </div>

            <div className="block">
              <div className="sideTitle">Add category</div>
              <div className="row">
                <label className="label">
                  Name
                  <input
                    className="input"
                    value={newCatName}
                    onChange={(e) => setNewCatName(e.target.value)}
                    placeholder="Work"
                  />
                </label>
                <label className="label">
                  Color
                  <input
                    className="input"
                    type="color"
                    value={isHexColor(newCatColor) ? newCatColor : '#888888'}
                    onChange={(e) => setNewCatColor(e.target.value)}
                  />
                </label>
              </div>
              <div className="row">
                <label className="label" style={{ flex: 1 }}>
                  Description
                  <input
                    className="input"
                    value={newCatDescription}
                    onChange={(e) => setNewCatDescription(e.target.value)}
                    placeholder="What does this category represent?"
                  />
                </label>
                <button
                  className="btn btn-accent"
                  disabled={catBusy}
                  onClick={() =>
                    void (async () => {
                      try {
                        setCatErr(null)
                        setCatBusy(true)
                        await props.onCreateCategory({
                          name: newCatName,
                          color: newCatColor,
                          description: newCatDescription
                        })
                        setNewCatName('')
                        setNewCatDescription('')
                      } catch (e) {
                        setCatErr(e instanceof Error ? e.message : String(e))
                      } finally {
                        setCatBusy(false)
                      }
                    })()
                  }
                >
                  Create
                </button>
              </div>
            </div>

            <div className="block">
              <div className="sideTitle">Categories</div>
              {orderedCategories.length === 0 ? <div className="mono">No categories</div> : null}
              {orderedCategories.map((c) => {
                const d = categoryDrafts[c.id] ?? {
                  name: c.name,
                  color: c.color,
                  description: c.description
                }

                const dirty = d.name !== c.name || d.color !== c.color || d.description !== c.description

                return (
                  <div key={c.id} className="block" style={{ padding: 12 }}>
                    <div className="row" style={{ alignItems: 'end' }}>
                      <label className="label" style={{ flex: 1 }}>
                        Name
                        <input
                          className="input"
                          value={d.name}
                          disabled={!!c.locked}
                          onChange={(e) =>
                            setCategoryDrafts((prev) => ({
                              ...prev,
                              [c.id]: { ...d, name: e.target.value }
                            }))
                          }
                        />
                      </label>
                      <label className="label">
                        Color
                        <input
                          className="input"
                          type="color"
                          value={isHexColor(d.color) ? d.color : '#888888'}
                          onChange={(e) =>
                            setCategoryDrafts((prev) => ({
                              ...prev,
                              [c.id]: { ...d, color: e.target.value }
                            }))
                          }
                        />
                      </label>
                      <button
                        className="btn"
                        disabled={catBusy || !dirty}
                        onClick={() =>
                          void (async () => {
                            try {
                              setCatErr(null)
                              setCatBusy(true)
                              await props.onUpdateCategory({
                                id: c.id,
                                patch: { name: d.name, color: d.color, description: d.description }
                              })
                            } catch (e) {
                              setCatErr(e instanceof Error ? e.message : String(e))
                            } finally {
                              setCatBusy(false)
                            }
                          })()
                        }
                      >
                        Save
                      </button>
                      <button
                        className="btn"
                        disabled={!!c.locked || catBusy}
                        onClick={() => {
                          setPendingDeleteCategoryId(c.id)
                          setPendingDeleteCategoryReassignId(
                            orderedCategories.find((x) => x.id !== c.id)?.id ?? ''
                          )
                        }}
                      >
                        Delete…
                      </button>
                    </div>

                    <div className="row">
                      <label className="label" style={{ flex: 1 }}>
                        Description
                        <input
                          className="input"
                          value={d.description ?? ''}
                          onChange={(e) =>
                            setCategoryDrafts((prev) => ({
                              ...prev,
                              [c.id]: { ...d, description: e.target.value }
                            }))
                          }
                        />
                      </label>
                      {c.locked ? <div className="pill">Locked</div> : null}
                    </div>

                    {pendingDeleteCategoryId === c.id ? (
                      <div className="row" style={{ alignItems: 'end' }}>
                        <label className="label" style={{ flex: 1 }}>
                          Reassign existing cards to
                          <select
                            className="input"
                            value={pendingDeleteCategoryReassignId}
                            onChange={(e) => setPendingDeleteCategoryReassignId(e.target.value)}
                          >
                            {orderedCategories
                              .filter((x) => x.id !== c.id)
                              .map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name}
                                </option>
                              ))}
                          </select>
                        </label>
                        <button
                          className="btn btn-accent"
                          disabled={!pendingDeleteCategoryReassignId || catBusy}
                          onClick={() =>
                            void (async () => {
                              try {
                                setCatErr(null)
                                setCatBusy(true)
                                await props.onDeleteCategory({
                                  id: c.id,
                                  reassignToCategoryId: pendingDeleteCategoryReassignId
                                })
                                setPendingDeleteCategoryId(null)
                                setPendingDeleteCategoryReassignId('')
                              } catch (e) {
                                setCatErr(e instanceof Error ? e.message : String(e))
                              } finally {
                                setCatBusy(false)
                              }
                            })()
                          }
                        >
                          Confirm delete
                        </button>
                        <button
                          className="btn"
                          disabled={catBusy}
                          onClick={() => {
                            setPendingDeleteCategoryId(null)
                            setPendingDeleteCategoryReassignId('')
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>

            <div className="block">
              <div className="sideTitle">Subcategories</div>
              <div className="row">
                <label className="label">
                  Category
                  <select
                    className="input"
                    value={activeCategoryId}
                    onChange={(e) => setActiveCategoryId(e.target.value)}
                  >
                    {orderedCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="block">
                <div className="sideTitle">Add subcategory</div>
                <div className="row">
                  <label className="label" style={{ flex: 1 }}>
                    Name
                    <input
                      className="input"
                      value={newSubName}
                      onChange={(e) => setNewSubName(e.target.value)}
                      placeholder="Coding"
                    />
                  </label>
                  <label className="label">
                    Color
                    <input
                      className="input"
                      type="color"
                      value={isHexColor(newSubColor) ? newSubColor : '#888888'}
                      onChange={(e) => setNewSubColor(e.target.value)}
                    />
                  </label>
                </div>
                <div className="row">
                  <label className="label" style={{ flex: 1 }}>
                    Description
                    <input
                      className="input"
                      value={newSubDescription}
                      onChange={(e) => setNewSubDescription(e.target.value)}
                      placeholder="Optional details"
                    />
                  </label>
                  <button
                    className="btn btn-accent"
                    disabled={!activeCategoryId || catBusy}
                    onClick={() =>
                      void (async () => {
                        try {
                          setCatErr(null)
                          setCatBusy(true)
                          await props.onCreateSubcategory({
                            categoryId: activeCategoryId,
                            name: newSubName,
                            color: newSubColor,
                            description: newSubDescription
                          })
                          setNewSubName('')
                          setNewSubDescription('')
                        } catch (e) {
                          setCatErr(e instanceof Error ? e.message : String(e))
                        } finally {
                          setCatBusy(false)
                        }
                      })()
                    }
                  >
                    Create
                  </button>
                </div>
              </div>

              {subcategoriesForActive.length === 0 ? <div className="mono">No subcategories</div> : null}
              {subcategoriesForActive.map((s) => {
                const d = subcategoryDrafts[s.id] ?? {
                  name: s.name,
                  color: s.color,
                  description: s.description
                }
                const dirty = d.name !== s.name || d.color !== s.color || d.description !== s.description

                return (
                  <div key={s.id} className="block" style={{ padding: 12 }}>
                    <div className="row" style={{ alignItems: 'end' }}>
                      <label className="label" style={{ flex: 1 }}>
                        Name
                        <input
                          className="input"
                          value={d.name}
                          onChange={(e) =>
                            setSubcategoryDrafts((prev) => ({
                              ...prev,
                              [s.id]: { ...d, name: e.target.value }
                            }))
                          }
                        />
                      </label>
                      <label className="label">
                        Color
                        <input
                          className="input"
                          type="color"
                          value={isHexColor(d.color) ? d.color : '#888888'}
                          onChange={(e) =>
                            setSubcategoryDrafts((prev) => ({
                              ...prev,
                              [s.id]: { ...d, color: e.target.value }
                            }))
                          }
                        />
                      </label>
                      <button
                        className="btn"
                        disabled={catBusy || !dirty}
                        onClick={() =>
                          void (async () => {
                            try {
                              setCatErr(null)
                              setCatBusy(true)
                              await props.onUpdateSubcategory({
                                id: s.id,
                                patch: { name: d.name, color: d.color, description: d.description }
                              })
                            } catch (e) {
                              setCatErr(e instanceof Error ? e.message : String(e))
                            } finally {
                              setCatBusy(false)
                            }
                          })()
                        }
                      >
                        Save
                      </button>
                      <button
                        className="btn"
                        disabled={catBusy}
                        onClick={() => {
                          setPendingDeleteSubId(s.id)
                          setPendingDeleteSubMode('clear')
                          setPendingDeleteSubReassignId(
                            subcategoriesForActive.find((x) => x.id !== s.id)?.id ?? ''
                          )
                        }}
                      >
                        Delete…
                      </button>
                    </div>

                    <div className="row">
                      <label className="label" style={{ flex: 1 }}>
                        Description
                        <input
                          className="input"
                          value={d.description ?? ''}
                          onChange={(e) =>
                            setSubcategoryDrafts((prev) => ({
                              ...prev,
                              [s.id]: { ...d, description: e.target.value }
                            }))
                          }
                        />
                      </label>
                    </div>

                  {pendingDeleteSubId === s.id ? (
                    <div className="row" style={{ alignItems: 'end' }}>
                      <label className="label" style={{ flex: 1 }}>
                        On delete
                        <select
                          className="input"
                          value={pendingDeleteSubMode}
                          onChange={(e) => setPendingDeleteSubMode(e.target.value as any)}
                        >
                          <option value="clear">Clear subcategory on cards</option>
                          <option value="reassign">Reassign to another subcategory</option>
                        </select>
                      </label>
                      {pendingDeleteSubMode === 'reassign' ? (
                        <label className="label" style={{ flex: 1 }}>
                          Reassign to
                          <select
                            className="input"
                            value={pendingDeleteSubReassignId}
                            onChange={(e) => setPendingDeleteSubReassignId(e.target.value)}
                          >
                            {subcategoriesForActive
                              .filter((x) => x.id !== s.id)
                              .map((x) => (
                                <option key={x.id} value={x.id}>
                                  {x.name}
                                </option>
                              ))}
                          </select>
                        </label>
                      ) : null}
                      <button
                        className="btn btn-accent"
                        disabled={
                          catBusy ||
                          (pendingDeleteSubMode === 'reassign' && !pendingDeleteSubReassignId)
                        }
                        onClick={() =>
                          void (async () => {
                            try {
                              setCatErr(null)
                              setCatBusy(true)
                              if (pendingDeleteSubMode === 'reassign') {
                                await props.onDeleteSubcategory({
                                  id: s.id,
                                  mode: 'reassign',
                                  reassignToSubcategoryId: pendingDeleteSubReassignId
                                })
                              } else {
                                await props.onDeleteSubcategory({ id: s.id, mode: 'clear' })
                              }
                              setPendingDeleteSubId(null)
                              setPendingDeleteSubReassignId('')
                            } catch (e) {
                              setCatErr(e instanceof Error ? e.message : String(e))
                            } finally {
                              setCatBusy(false)
                            }
                          })()
                        }
                      >
                        Confirm delete
                      </button>
                      <button
                        className="btn"
                        disabled={catBusy}
                        onClick={() => {
                          setPendingDeleteSubId(null)
                          setPendingDeleteSubReassignId('')
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {active === 'analysis' ? (
          <div className="settingsSection">
            <div className="sideTitle">Analysis</div>
            <div className="sideMeta">
              Tuning affects how screenshots are grouped into batches and how much recent context is used to generate
              cards.
            </div>

            <div className="block">
              <div className="sideTitle">Presets</div>
              <div className="sideMeta">Pick a preset to fill values; click Save to apply.</div>
              <div className="row">
                <button
                  className="btn"
                  title="Balanced defaults (recommended)"
                  onClick={() => props.onApplyAnalysisPreset('balanced')}
                >
                  Balanced
                </button>
                <button className="btn" title="Faster updates (more frequent, smaller batches)" onClick={() => props.onApplyAnalysisPreset('faster')}>
                  Faster updates
                </button>
                <button className="btn" title="Lower resource use (less frequent, larger batches)" onClick={() => props.onApplyAnalysisPreset('low_resource')}>
                  Low resource
                </button>
                <button className="btn" title="Catch up after downtime (longer lookback)" onClick={() => props.onApplyAnalysisPreset('catch_up')}>
                  Catch-up
                </button>
              </div>
            </div>

            <div className="block">
              <div className="sideTitle">Scheduler</div>
              <div className="row">
                <label
                  className="label"
                  title="How often Chrona checks for new screenshots to batch and analyze."
                >
                  Check interval (seconds)
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={props.analysisCheckIntervalSeconds}
                    onChange={(e) => props.setAnalysisCheckIntervalSeconds(e.target.value)}
                  />
                </label>
                <label
                  className="label"
                  title="Only screenshots within this window are eligible for batching. Older unprocessed screenshots will be ignored. Example: 86400 = 24h."
                >
                  Lookback window (seconds)
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={60}
                    value={props.analysisLookbackSeconds}
                    onChange={(e) => props.setAnalysisLookbackSeconds(e.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="block">
              <div className="sideTitle">Batching &amp; cards</div>
              <div className="row">
                <label
                  className="label"
                  title="Screenshots are grouped up to this length before Gemini runs. Shorter = faster updates / more calls; longer = slower updates / fewer calls."
                >
                  Target batch duration (minutes)
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={props.analysisBatchTargetMinutes}
                    onChange={(e) => props.setAnalysisBatchTargetMinutes(e.target.value)}
                  />
                </label>
                <label
                  className="label"
                  title="If the time gap between consecutive screenshots exceeds this, a new batch starts. Increase if you miss captures; decrease for tighter grouping."
                >
                  Max gap in batch (minutes)
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={props.analysisBatchMaxGapMinutes}
                    onChange={(e) => props.setAnalysisBatchMaxGapMinutes(e.target.value)}
                  />
                </label>
              </div>
              <div className="row">
                <label
                  className="label"
                  title="Batches shorter than this are skipped (avoids tiny/low-signal Gemini calls)."
                >
                  Min batch duration (minutes)
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={props.analysisMinBatchMinutes}
                    onChange={(e) => props.setAnalysisMinBatchMinutes(e.target.value)}
                  />
                </label>
                <label
                  className="label"
                  title="How much recent history Gemini sees when generating cards (sliding window). Larger = more context / more tokens."
                >
                  Card generation window (minutes)
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={props.analysisCardWindowMinutes}
                    onChange={(e) => props.setAnalysisCardWindowMinutes(e.target.value)}
                  />
                </label>
              </div>
              <div className="row">
                <button className="btn btn-accent" onClick={() => void props.onSaveAnalysisConfig()}>
                  Save analysis settings
                </button>
              </div>
            </div>

            <div className="block">
              <div className="sideTitle">Manual</div>
              <div className="sideMeta">Runs one analysis tick immediately (in addition to the scheduler).</div>
              <div className="row">
                <button className="btn" onClick={() => void props.onRunAnalysisTick()}>
                  Run analysis tick
                </button>
                <div className="mono">{props.analysisLine || '...'}</div>
              </div>
            </div>
          </div>
        ) : null}

        {active === 'ai' ? (
          <div className="settingsSection">
            <div className="sideTitle">AI (Gemini)</div>
            <div className="sideMeta">Configure the Gemini API key, model, and runtime options.</div>

            <div className="block">
              <div className="sideTitle">API key</div>
              <div className="sideMeta">
                Key: {props.hasGeminiKey === null ? '...' : props.hasGeminiKey ? 'configured' : 'missing'}
              </div>
              <div className="row">
                <input
                  className="input"
                  type="password"
                  value={props.geminiKeyInput}
                  placeholder="AIza..."
                  onChange={(e) => props.setGeminiKeyInput(e.target.value)}
                />
                <button className="btn" onClick={() => void props.onSaveGeminiKey()}>
                  Save
                </button>
              </div>
            </div>

            <div className="block">
              <div className="sideTitle">Model</div>
              <div className="row">
                <label className="label">
                  Model ID
                  <input
                    className="input"
                    value={props.geminiModel}
                    onChange={(e) => props.setGeminiModel(e.target.value)}
                    placeholder="gemini-2.5-flash"
                  />
                </label>
                <div className="row" style={{ padding: 0 }}>
                  <select
                    className="input"
                    value={GEMINI_MODELS.includes(props.geminiModel as any) ? props.geminiModel : ''}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v) props.setGeminiModel(v)
                    }}
                  >
                    <option value="">Presets…</option>
                    {GEMINI_MODELS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="block">
              <div className="sideTitle">Runtime</div>
              <div className="row">
                <label className="label">
                  Request timeout (ms)
                  <input
                    className="input"
                    type="number"
                    min={1000}
                    step={1000}
                    value={props.geminiRequestTimeoutMs}
                    onChange={(e) => props.setGeminiRequestTimeoutMs(Number(e.target.value))}
                  />
                </label>
                <label className="label">
                  Max attempts
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={props.geminiMaxAttempts}
                    onChange={(e) => props.setGeminiMaxAttempts(Number(e.target.value))}
                  />
                </label>
              </div>

              <div className="row">
                <label className="pill">
                  <input
                    type="checkbox"
                    checked={props.geminiLogBodies}
                    onChange={(e) => props.setGeminiLogBodies(e.target.checked)}
                  />
                  Verbose LLM logging (store bodies)
                </label>
              </div>

              <div className="row">
                <button className="btn" onClick={() => void props.onSaveGeminiRuntime()}>
                  Save Gemini settings
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {active === 'prompts' ? (
          <div className="settingsSection">
            <div className="sideTitle">Prompts</div>
            <div className="sideMeta">
              These instructions are inserted near the top of Chrona’s default prompts. Keep them short and compatible
              with JSON-only outputs.
            </div>

            <div className="block">
              <div className="sideTitle">Transcription preamble</div>
              <textarea
                className="input settingsTextarea"
                rows={6}
                value={props.promptPreambleTranscribe}
                onChange={(e) => props.setPromptPreambleTranscribe(e.target.value)}
                placeholder="Example: Prefer naming apps and websites when clear."
              />
            </div>

            <div className="block">
              <div className="sideTitle">Card generation preamble</div>
              <textarea
                className="input settingsTextarea"
                rows={6}
                value={props.promptPreambleCards}
                onChange={(e) => props.setPromptPreambleCards(e.target.value)}
                placeholder="Example: Use shorter cards when context switches happen quickly."
              />
            </div>

            <div className="block">
              <div className="sideTitle">Ask preamble</div>
              <textarea
                className="input settingsTextarea"
                rows={6}
                value={props.promptPreambleAsk}
                onChange={(e) => props.setPromptPreambleAsk(e.target.value)}
                placeholder="Example: Prefer bullet answers and cite sources for claims."
              />
            </div>

            <div className="block">
              <div className="sideTitle">Journal draft preamble</div>
              <textarea
                className="input settingsTextarea"
                rows={6}
                value={props.promptPreambleJournalDraft}
                onChange={(e) => props.setPromptPreambleJournalDraft(e.target.value)}
                placeholder="Example: Keep tone direct and action-oriented."
              />
            </div>

            <div className="row">
              <button className="btn" onClick={() => void props.onSavePromptPreambles()}>
                Save prompt settings
              </button>
            </div>
          </div>
        ) : null}

        {active === 'storage' ? (
          <div className="settingsSection">
            <div className="sideTitle">Storage</div>
            <div className="sideMeta">
              {props.storageUsage
                ? `Recordings: ${formatBytes(props.storageUsage.recordingsBytes)} / ${formatBytes(props.storageUsage.recordingsLimitBytes)} · Timelapses: ${formatBytes(props.storageUsage.timelapsesBytes)} / ${formatBytes(props.storageUsage.timelapsesLimitBytes)}`
                : 'Loading...'}
            </div>

            <div className="block">
              <div className="sideTitle">Limits</div>
              <div className="row">
                <label className="label">
                  Recordings limit (GB)
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={props.limitRecordingsGb}
                    onChange={(e) => props.setLimitRecordingsGb(e.target.value)}
                  />
                </label>
                <label className="label">
                  Timelapses limit (GB)
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={props.limitTimelapsesGb}
                    onChange={(e) => props.setLimitTimelapsesGb(e.target.value)}
                  />
                </label>
              </div>
              <div className="row">
                <button className="btn" onClick={() => void props.onSaveStorageLimits()}>
                  Save limits
                </button>
                <button className="btn" onClick={() => void props.onPurgeNow()}>
                  Purge now
                </button>
                <button className="btn" onClick={() => void window.chrona.openRecordingsFolder()}>
                  Open recordings
                </button>
              </div>
            </div>

            <div className="block">
              <div className="sideTitle">Timelapses</div>
              <div className="row">
                <label className="pill">
                  <input
                    type="checkbox"
                    checked={props.timelapsesEnabled}
                    onChange={(e) => void props.onToggleTimelapsesEnabled(e.target.checked)}
                  />
                  Generate timelapses
                </label>
              </div>
              <div className="row">
                <label className="label">
                  Timelapse FPS
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    value={props.timelapseFps}
                    onChange={(e) => props.setTimelapseFps(Number(e.target.value))}
                  />
                </label>
                <button className="btn" onClick={() => void props.onSaveTimelapseFps()}>
                  Save FPS
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {active === 'app' ? (
          <div className="settingsSection">
            <div className="sideTitle">App</div>
            <div className="sideMeta">System integration and behavior.</div>

            <div className="row">
              <label className="pill">
                <input
                  type="checkbox"
                  checked={props.autoStartEnabled}
                  onChange={(e) => void props.onToggleAutoStartEnabled(e.target.checked)}
                />
                Launch at login
              </label>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(String(s ?? '').trim())
}
