import { ArrowUp, FileText, Loader2, Paperclip, PanelRightOpen, Square, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import type { ConsoleState } from './use-console-state'

/** Message composer: attachments, run settings, engine status and send/stop actions. */
export function ConsoleComposer({
  state,
  handleSubmit,
  handleFileSelect,
}: {
  state: ConsoleState
  handleSubmit: (overrideInput?: string) => Promise<void>
  handleFileSelect: (files: FileList | null) => Promise<void>
}) {
  const {
    fileInputRef,
    t,
    attachedFiles,
    setAttachedFiles,
    skillsFailed,
    capabilityMatrixFailed,
    setCatalogRefresh,
    runPolicy,
    locale,
    selectedSkillIds,
    availableSkills,
    isStreaming,
    sessionRuntime,
    conversationId,
    composerTextareaRef,
    input,
    setInput,
    allEngines,
    probeResults,
    probeButtonRef,
    probePopupOpen,
    setProbePopupOpen,
    probeAllEngines,
    probeAllRunning,
    setInputReviewOpen,
    setResultReviewOpen,
    isIdle,
    setActivePanel,
    setResultDialogOpen,
    streamingSessions,
    stopStream,
    uploadingCount,
    submittingRef,
    skillsLoaded,
    capabilityMatrixLoaded,
    endingTurnConversationId,
  } = state
  const skillName = (id: string) => {
    const skill = availableSkills.find(entry => entry.id === id)
    return skill ? skill.name[locale] || skill.name.en || id : id
  }
  const modeling = sessionRuntime.view?.modeling
  const usageLabel = !conversationId || sessionRuntime.view && !sessionRuntime.view.usage ? t('policySkillsNotStarted')
    : !modeling ? t('policySkillUsageUnavailable')
      : modeling.usedSkillIds.length ? modeling.usedSkillIds.map(skillName).join(', ')
        : modeling.routedSkillId ? `${skillName(modeling.routedSkillId)} (${t('policySkillNotInvoked')})`
          : t('policyNoSkillsUsed')

  return (
    <div className="rounded-[24px] border border-border/70 bg-background/70 p-2.5 dark:border-white/10 dark:bg-black/20">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.csv,.tsv,.json,.xlsx,.xls,.png,.jpg,.jpeg,.gif,.webp,.bmp,.dxf,.txt,.at2"
        aria-label={t('attachFile')}
        className="hidden"
        onChange={(e) => { handleFileSelect(e.target.files); e.target.value = '' }}
      />
      {attachedFiles.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5 px-3">
          {attachedFiles.map((f) => (
            <span
              key={f.fileId}
              className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground dark:border-white/10 dark:bg-white/5"
            >
              <FileText className="h-3 w-3 shrink-0" />
              <span className="max-w-[120px] truncate">{f.originalName}</span>
              <button
                type="button"
                aria-label={t('removeAttachment')}
                className="ml-0.5 rounded-full hover:text-foreground"
                onClick={() => setAttachedFiles((prev) => prev.filter((x) => x.fileId !== f.fileId))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {(skillsFailed || capabilityMatrixFailed) && <div role="alert" className="mx-3 mb-2 text-sm text-amber-700 dark:text-amber-300">
        <p>{t('capabilityCatalogFailed')}</p>
        <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setCatalogRefresh(value => value + 1)}>{t('capabilityCatalogRetry')}</Button>
      </div>}
      <p role="status" className="mx-3 mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="run-skill-summary">
        <span>{t('policyEffectiveScope')}: {runPolicy.routing?.mode === 'fixed' ? skillName(runPolicy.routing.skillId)
          : sessionRuntime.view?.policy?.routing.mode === 'fixed' && runPolicy.routing === undefined ? skillName(sessionRuntime.view.policy.routing.skillId)
          : state.hasExplicitSkillSelection ? selectedSkillIds.map(skillName).join(', ') || t('policyScopeEmpty') : t('policyScopeAutomatic')}</span>
        <span data-testid="run-used-skills">{t(modeling?.routedSkillId && !modeling.usedSkillIds.length ? 'policySkillRouted' : 'policyActualSkills')}: {usageLabel}</span>
      </p>
      <Textarea
        ref={composerTextareaRef}
        className="min-h-[96px] resize-none border-0 bg-transparent px-3 py-2.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
        placeholder={t('composerPlaceholder')}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            handleSubmit()
          }
        }}
      />
      <Separator className="bg-border dark:bg-white/10" />
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="border-border/70 bg-background/70 text-muted-foreground dark:border-white/10 dark:bg-white/5" variant="outline">
            {t('conversationIdShort')} {conversationId ? conversationId.slice(0, 8) : t('notCreated')}
          </Badge>
          {allEngines.length > 0 && (
            <div className="flex items-center gap-1.5">
              {allEngines.map((engine) => {
                const probe = probeResults[engine.id]
                const dotColor = probe
                  ? (probe.loading ? 'bg-amber-400 dark:bg-amber-300' : (probe.passed ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-red-400 dark:bg-red-500'))
                  : 'bg-gray-400 dark:bg-gray-500'
                return (
                  <span
                    key={engine.id}
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
                    title={probe ? undefined : (engine.unavailableReason || (engine.available ? t('engineStatusAvailable') : t('engineStatusUnavailable')))}
                  >
                    <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
                    <span className={probe ? (probe.passed ? '' : 'opacity-50') : 'opacity-60'}>{engine.name}</span>
                  </span>
                )
              })}
              <div className="relative ml-1">
                <button
                  ref={probeButtonRef}
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={probePopupOpen}
                  className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground transition hover:border-cyan-300/30 hover:text-foreground disabled:opacity-50 dark:border-white/10 dark:bg-white/5"
                  onClick={() => {
                    const hasResults = Object.keys(probeResults).length > 0
                    if (hasResults) {
                      setProbePopupOpen((v) => !v)
                    } else {
                      probeAllEngines()
                    }
                  }}
                  disabled={probeAllRunning}
                >
                  {probeAllRunning ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  {t('engineProbeButton')}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" className="rounded-full text-xs" disabled={!conversationId || isStreaming}
            onClick={() => setInputReviewOpen(true)}>{locale === 'zh' ? '输入与证据' : 'Inputs and evidence'}</Button>
          <Button type="button" variant="outline" size="sm" disabled={!conversationId || isStreaming} onClick={() => setResultReviewOpen(true)}>{locale === 'zh' ? '结果与历史' : 'Results and history'}</Button>
          <Button
            type="button"
            variant="outline"
            className="rounded-full text-xs"
            onClick={() => {
              if (isIdle) {
                setActivePanel('context')
              }
              setResultDialogOpen(true)
            }}
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
            {isIdle ? t('contextTab') : t('showResults')}
          </Button>
          {streamingSessions.get(conversationId)?.status === 'streaming' ? (
            <Button
              type="button"
              className="rounded-full bg-rose-500 px-5 text-white hover:bg-rose-400"
              onClick={() => stopStream()}
            >
              <Square className="h-4 w-4" />
              {t('stopStreaming')}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t('attachFile')}
                title={uploadingCount > 0 ? t('uploadingFile') : t('attachFile')}
                className="rounded-full"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingCount > 0 || submittingRef.current}
              >
                {uploadingCount > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
              </Button>
              <Button
                type="button"
                className="rounded-full bg-cyan-300 px-5 text-slate-950 hover:bg-cyan-200"
                onClick={() => handleSubmit()}
                disabled={!skillsLoaded || !capabilityMatrixLoaded || !input.trim() || submittingRef.current || Boolean(endingTurnConversationId)}
              >
                <ArrowUp className="h-4 w-4" />
                {t('sendMessage')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
