import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fieldEdit, InputReviewPanel, type InputReviewSnapshot } from '@/components/chat/input-review-panel'

const evidence = { id: 'csv-source', field: 'file:.uploads/c/wave.csv:fields', status: 'unread', required: true,
  source: { file: '.uploads/c/wave.csv', complete: true, sha256: 'original', fileReference: { parsedSha256: 'parsed' } } }
const snapshot: InputReviewSnapshot = { conversationId: 'c', revisionToken: 'r1', model: { nodes: [{ id: 'A', x: 0 }] }, modelRevision: 2, modelPending: false,
  inputEvidence: [evidence], activeEvidenceIds: ['csv-source'], inputIssues: [{ field: evidence.field, reason: 'Needs field mapping' }],
  groundMotionRecords: [], allowedTools: ['analyze_file', 'review_input', 'edit_model', 'validate_model'], waitingForReply: true,
  analysisCurrent: false, reportCurrent: false, runUsage: { toolCalls: 3, llmCalls: 1 } }
const response = (data: unknown, ok = true, status = 200) => ({ ok, status, json: async () => data }) as Response
const attachment = { fileId: 'wave', originalName: 'wave.csv', relPath: '.uploads/c/wave.csv' }
const props = { open: true, onClose: vi.fn(), conversationId: 'c', locale: 'en' as const, disabled: false,
  attachments: [attachment], initialContext: { enabledToolIds: ['review_input'] }, onUpdate: vi.fn() }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('conversation input review', () => {
  it('maps a reviewed table cell to a stable field and preserves the revision and scope', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(snapshot)).mockResolvedValue(response({ success: true, result: { modelValues: [{ field: 'nodes.A.x', value: 4, unit: 'm' }] }, review: { ...snapshot, revisionToken: 'r2' } }))
    vi.stubGlobal('fetch', fetch)
    render(<InputReviewPanel {...props} />)
    await screen.findByText('Confirm fields and sources')
    fireEvent.change(screen.getByLabelText('Evidence field'), { target: { value: 'nodes.A.x' } })
    fireEvent.change(screen.getByLabelText('Source evidence'), { target: { value: 'csv-source' } })
    fireEvent.change(screen.getByLabelText('Confirmed value (text or JSON)'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Source unit'), { target: { value: 'm' } })
    fireEvent.change(screen.getByLabelText('Table row (one based)'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Table column (name or one based)'), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('Review / exclusion reason (required)'), { target: { value: 'Dimension confirmed on drawing' } })
    fireEvent.click(screen.getByText('Save review'))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ revisionToken: 'r1', tool: 'review_input', initialContext: props.initialContext,
      args: { resolutions: [{ field: 'nodes.A.x', value: 4, unit: 'm', sourceEvidenceId: 'csv-source', sourceLocation: { row: 2, column: 'x' } }] } })
    await screen.findByText('Apply reviewed value to model')
    expect(props.onUpdate).toHaveBeenCalledWith(expect.objectContaining({ revisionToken: 'r2' }))
  })
  it('uses the complete-file preview and explicitly confirms its source with a reason', async () => {
    const motionRecord = { id: 'record-one', direction: 'x', unit: 'g', fileReference: { parsedSha256: 'parsed' } }
    const fetch = vi.fn().mockResolvedValueOnce(response(snapshot))
      .mockResolvedValueOnce(response({ success: true, result: { groundMotionRecord: motionRecord,
        groundMotionPreview: { pointCount: 250, dt: .01, duration: 2.49, pgaMps2: 3, direction: 'x', preview: { points: [{ time: 0, acceleration: 0 }, { time: 2.49, acceleration: 3 }] } } }, review: { ...snapshot, revisionToken: 'r2' } }))
      .mockResolvedValue(response({ success: true, result: {}, review: { ...snapshot, revisionToken: 'r3' } }))
    vi.stubGlobal('fetch', fetch)
    render(<InputReviewPanel {...props} />)
    await screen.findByText('Use as a ground motion')
    fireEvent.change(screen.getByLabelText('Global excitation direction (required)'), { target: { value: 'x' } })
    fireEvent.change(screen.getByLabelText('Acceleration unit'), { target: { value: 'g' } })
    fireEvent.change(screen.getByLabelText('Acceleration column (name or zero based)'), { target: { value: '1' } })
    fireEvent.click(screen.getByText('Parse and preview complete record'))
    await screen.findByText(/Samples: 250/)
    expect(JSON.parse(fetch.mock.calls[1][1].body).args).toEqual({ filePath: attachment.relPath, groundMotion: { accelerationColumn: 1, direction: 'x', unit: 'g' } })
    expect(screen.getByText('Confirm source and sampling settings')).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Review / exclusion reason (required)'), { target: { value: 'X axis and units confirmed' } })
    fireEvent.click(screen.getByText('Confirm source and sampling settings'))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ revisionToken: 'r2', tool: 'review_input',
      args: { resolutions: [{ field: evidence.field, sourceEvidenceId: 'csv-source', analysisRecordId: 'record-one', value: true }] } })
  })
  it('keeps forbidden tools disabled in Chinese and exclusion requires a reason', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ...snapshot, allowedTools: ['review_input'] })))
    render(<InputReviewPanel {...props} locale="zh" />)
    await screen.findByText('确认字段与来源')
    expect(screen.getByText('完整读取此文件／页')).toBeDisabled()
    expect(screen.getByText('排除此无关来源')).toBeDisabled()
    expect(screen.getByText(/会话正在等待答复/)).toBeInTheDocument()
  })
  it('rejects structural ID changes and identifies the owning case of a load', () => {
    expect(fieldEdit('materials.steel.E', 206000)).toEqual({ operation: 'update', collection: 'materials', id: 'steel', values: { E: 206000 } })
    expect(fieldEdit('load_cases.D.loads.P.position', .4)).toEqual({ operation: 'update', collection: 'loads', caseId: 'D', id: 'P', values: { position: .4 } })
    expect(fieldEdit('nodes.A.id', 'B')).toBeNull()
    expect(fieldEdit('nodes.A.__proto__.polluted', true)).toBeNull()
    expect(fieldEdit('nodes.A.b.x', 5, { nodes: [{ id:'A', x:0 }, { id:'A.b', x:4 }] }))
      .toEqual({ operation:'update', collection:'nodes', id:'A.b', values:{x:5} })
    expect(fieldEdit('load_cases.D.1.loads.P.2.position', .5, { load_cases:[{id:'D.1',loads:[{id:'P.2',position:.4}]}] }))
      .toEqual({ operation:'update', collection:'loads', caseId:'D.1', id:'P.2', values:{position:.5} })
  })
})
