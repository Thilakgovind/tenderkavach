import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  FileCheck2,
  FileUp,
  History,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  PlusCircle,
  Send,
  ShieldAlert,
  Wrench,
  X,
} from 'lucide-react';
import type { LanguageCode } from '../App';
import {
  ApiError,
  type IntegrationBoundaries,
  type SessionState,
  type ValidationStatus,
  fetchReportPreviewApi,
  downloadReport,
  recordDecisionApi,
  sendChatMessageApi,
  transcribeVoiceApi,
  uploadCorrectedPdfApi,
} from '../api/client';

export type WorkspaceTab = 'Chat' | 'Findings' | 'Rescue' | 'Report';

interface BidWorkspacePanelProps {
  open: boolean;
  session: SessionState | null;
  initialTab?: WorkspaceTab;
  language: LanguageCode;
  integrations?: IntegrationBoundaries;
  onClose: () => void;
  onSessionUpdate: (next: SessionState) => void;
  onStartNewAnalysis: () => void;
  onClearSession: () => void;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getSpeechRecognitionConstructor(): (new () => SpeechRecognitionInstance) | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as Record<string, unknown>;
  const ctor = win.SpeechRecognition || win.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as new () => SpeechRecognitionInstance) : null;
}

const STATUS_STYLE: Record<ValidationStatus, string> = {
  PASS: 'bg-emerald-950/70 text-emerald-200 border-emerald-400/40',
  EXPIRED: 'bg-red-950/70 text-red-200 border-red-400/45',
  MISSING: 'bg-red-950/70 text-red-200 border-red-400/45',
  FAIL: 'bg-red-950/70 text-red-200 border-red-400/45',
  MISMATCH: 'bg-orange-950/70 text-orange-200 border-orange-400/45',
  REVIEW_REQUIRED: 'bg-amber-950/70 text-amber-200 border-amber-400/45',
  NOT_APPLICABLE: 'bg-slate-900/70 text-slate-300 border-slate-500/35',
};

const URGENCY_STYLE = {
  CRITICAL: 'bg-red-950/80 text-red-200 border-red-400/45',
  HIGH: 'bg-orange-950/80 text-orange-200 border-orange-400/45',
  MEDIUM: 'bg-amber-950/80 text-amber-200 border-amber-400/45',
  LOW: 'bg-slate-900/80 text-slate-200 border-slate-500/40',
};

const QUICK_PROMPTS: Record<LanguageCode, string[]> = {
  Eng: [
    'Can we still bid?',
    'What is blocking us?',
    'What should I fix first?',
    'Explain R2',
    'Generate my report',
  ],
  Tam: [
    'நாம் இன்னும் ஏலம் போடலாமா?',
    'நம்மை தடுப்பது எது?',
    'முதலில் எதை சரிசெய்ய வேண்டும்?',
    'R2 விளக்கு',
    'அறிக்கை உருவாக்கு',
  ],
  Hin: [
    'Can we still bid?',
    'What is blocking us?',
    'What should I fix first?',
    'Explain R2',
    'Generate my report',
  ],
};

export function BidWorkspacePanel({
  open,
  session,
  initialTab = 'Chat',
  language,
  integrations,
  onClose,
  onSessionUpdate,
  onStartNewAnalysis,
  onClearSession,
}: BidWorkspacePanelProps) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(initialTab);
  const [messageInput, setMessageInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [chatError, setChatError] = useState('');
  const [uploadingCorrection, setUploadingCorrection] = useState(false);
  const [correctionStatus, setCorrectionStatus] = useState('');
  const [correctionTargetReq, setCorrectionTargetReq] = useState('');
  const [decisionNoteByReq, setDecisionNoteByReq] = useState<Record<string, string>>({});
  const [decisionBusyReq, setDecisionBusyReq] = useState<string | null>(null);
  const [decisionFeedbackMsg, setDecisionFeedbackMsg] = useState('');
  const [reportHtml, setReportHtml] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');

  const chatEndRef = useRef<HTMLDivElement>(null);
  const correctionFileRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (activeTab === 'Chat' && open) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [session?.chatHistory.length, activeTab, open]);

  useEffect(() => {
    if (!open || activeTab !== 'Report' || !session) return;
    let cancelled = false;
    setReportLoading(true);
    fetchReportPreviewApi(session.sessionId)
      .then((res) => {
        if (!cancelled) setReportHtml(res.html);
      })
      .catch(() => {
        if (!cancelled) setReportHtml('');
      })
      .finally(() => {
        if (!cancelled) setReportLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, activeTab, session?.sessionId, session?.revision]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  if (!open || !session) return null;

  const blockersCount = session.validation.filter(
    (v) => v.status !== 'PASS' && v.status !== 'NOT_APPLICABLE'
  ).length;
  const passedCount = session.validation.filter((v) => v.status === 'PASS').length;
  const reviewCount = session.validation.filter((v) => v.status === 'REVIEW_REQUIRED').length;

  const handleSendChat = async (textToSend?: string) => {
    const clean = (textToSend ?? messageInput).trim();
    if (!clean || sendingChat) return;
    setChatError('');
    setSendingChat(true);
    if (!textToSend) setMessageInput('');

    try {
      const res = await sendChatMessageApi({
        sessionId: session.sessionId,
        message: clean,
        language,
        revision: session.revision,
      });
      onSessionUpdate(res.session);
      if (res.exportReady) {
        setActiveTab('Report');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setChatError('Session state changed in another action. Please retry sending.');
      } else {
        setChatError(err instanceof Error ? err.message : 'Failed to process message.');
      }
      if (!textToSend) setMessageInput(clean);
    } finally {
      setSendingChat(false);
    }
  };

  const handleCorrectedUpload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setCorrectionStatus('Only .pdf files are accepted for corrected evidence.');
      return;
    }
    setUploadingCorrection(true);
    setCorrectionStatus('');
    try {
      const res = await uploadCorrectedPdfApi({
        sessionId: session.sessionId,
        correctedPdf: file,
        targetRequirementId: correctionTargetReq || undefined,
        revision: session.revision,
      });
      onSessionUpdate(res.session);
      setCorrectionStatus(
        res.affectedRequirements.length > 0
          ? `Rechecked ${res.affectedRequirements.join(', ')} using "${file.name}" (${res.progressSteps.join(' → ')}).`
          : `Ingested "${file.name}" — please select a requirement ID or check Findings for details.`
      );
      if (correctionFileRef.current) correctionFileRef.current.value = '';
    } catch (err) {
      setCorrectionStatus(err instanceof Error ? err.message : 'Corrected PDF upload failed.');
    } finally {
      setUploadingCorrection(false);
    }
  };

  const handleDecision = async (
    requirementId: string,
    action: 'agree' | 'dispute' | 'approve'
  ) => {
    setDecisionBusyReq(requirementId);
    setDecisionFeedbackMsg('');
    try {
      const note = (decisionNoteByReq[requirementId] || '').trim();
      const res = await recordDecisionApi({
        sessionId: session.sessionId,
        requirementId,
        action,
        note: note || `${action} recorded from Findings panel`,
        language,
        revision: session.revision,
      });
      onSessionUpdate(res.session);
      setDecisionFeedbackMsg(
        res.message || `Recorded ${action} for ${requirementId} (status unchanged until verified evidence changes).`
      );
      setDecisionNoteByReq((prev) => ({ ...prev, [requirementId]: '' }));
    } catch (err) {
      setDecisionFeedbackMsg(err instanceof Error ? err.message : 'Failed to record decision.');
    } finally {
      setDecisionBusyReq(null);
    }
  };

  const toggleVoiceInput = async () => {
    if (listening) {
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
        setVoiceNote('Transcribing your voice…');
      }
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    if (integrations?.sarvamVoice.connected && navigator.mediaDevices && typeof MediaRecorder !== 'undefined') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined });
        voiceChunksRef.current = [];
        mediaStreamRef.current = stream;
        recorder.ondataavailable = (event) => {
          if (event.data.size) voiceChunksRef.current.push(event.data);
        };
        recorder.onstop = async () => {
          mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
          try {
            const transcript = await transcribeVoiceApi(new Blob(voiceChunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
            setMessageInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
            setVoiceNote('Sarvam transcript is ready — review or edit it before sending.');
          } catch (err) {
            setVoiceNote(err instanceof Error ? err.message : 'Voice transcription failed. Please type your question.');
          }
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
        setListening(true);
        setVoiceNote('Listening with Sarvam. Tap the microphone again to transcribe.');
        return;
      } catch {
        setVoiceNote('Microphone permission was not granted. Please type your question.');
        return;
      }
    }
    const Ctor = getSpeechRecognitionConstructor();
    if (!Ctor) {
      setVoiceNote(
        'Browser speech recognition is unavailable here. Sarvam AI voice is not connected yet — type or paste Tamil/English directly below.'
      );
      return;
    }
    try {
      const rec = new Ctor();
      rec.lang = language === 'Tam' ? 'ta-IN' : language === 'Hin' ? 'hi-IN' : 'en-IN';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        const transcript = e.results?.[0]?.[0]?.transcript?.trim() || '';
        if (transcript) {
          setMessageInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
          setVoiceNote('Transcript placed in the box below — review or edit before sending.');
        }
      };
      rec.onerror = () => {
        setListening(false);
        setVoiceNote('Microphone capture failed or permission denied. Please type your question.');
      };
      rec.onend = () => {
        setListening(false);
      };
      recognitionRef.current = rec;
      rec.start();
      setListening(true);
      setVoiceNote(
        `Listening (${rec.lang}). Speech goes into editable text before sending (Sarvam AI not connected).`
      );
    } catch {
      setListening(false);
      setVoiceNote('Could not start speech recognition. Please type your question.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-5 bg-black/80 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-label="Namma Tender Bid Rescue Workspace"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-5xl h-[92svh] max-h-[860px] rounded-2xl bg-[#0e0c18]/97 border border-white/15 text-white shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Workspace Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-3.5 border-b border-white/12 bg-[#131022]">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[10px] font-semibold tracking-wider uppercase ${
                  session.mode === 'SAMPLE'
                    ? 'bg-amber-950/80 text-amber-200 border-amber-400/50'
                    : 'bg-emerald-950/80 text-emerald-200 border-emerald-400/50'
                }`}
              >
                {session.mode === 'SAMPLE' ? 'SAMPLE MODE · FICTIONAL DATA' : 'LIVE MODE'}
              </span>
              <span className="text-[11px] font-mono text-white/60">
                {session.profile.tenderReference || session.sessionId}
              </span>
              <span className="text-[11px] text-white/60 inline-flex items-center gap-1">
                <Clock className="h-3 w-3 text-[#E0A458]" />
                {session.deadline.timeRemainingText} (Deadline {session.deadline.confirmedDate})
              </span>
            </div>
            <h2 className="mt-1 text-base sm:text-lg font-semibold truncate">
              {session.profile.companyName}{' '}
              <span className="text-xs font-normal text-white/60">
                · {session.profile.district} · {session.provider.model}
              </span>
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onStartNewAnalysis}
              className="h-8 px-3 rounded-full border border-white/20 text-xs text-white/85 hover:bg-white/10 transition-colors cursor-pointer inline-flex items-center gap-1.5"
            >
              <PlusCircle className="h-3.5 w-3.5 text-[#E0A458]" />
              <span>New Packet</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close Bid Rescue Workspace"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-white/75 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Summary KPI Strip & Tabs */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-6 py-2.5 border-b border-white/10 bg-[#110e1d]">
          <div className="flex items-center gap-1 sm:gap-2" role="tablist">
            {(
              [
                { id: 'Chat', label: 'Rescue Chat', icon: MessageSquare },
                {
                  id: 'Findings',
                  label: `Findings (${passedCount}/${session.requirements.length})`,
                  icon: FileCheck2,
                },
                {
                  id: 'Rescue',
                  label: `Rescue Plan (${session.plan.length})`,
                  icon: Wrench,
                },
                { id: 'Report', label: 'Report & Audit', icon: History },
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              const isSelected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => setActiveTab(tab.id)}
                  className={`h-8 px-3 rounded-full text-xs font-medium transition-colors cursor-pointer inline-flex items-center gap-1.5 ${
                    isSelected
                      ? 'bg-[#E0A458] text-[#1A1206] font-semibold'
                      : 'text-white/75 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 text-[11px]">
            <span className="px-2 py-0.5 rounded bg-emerald-950/70 border border-emerald-400/35 text-emerald-200 font-mono">
              PASS: {passedCount}
            </span>
            <span className="px-2 py-0.5 rounded bg-red-950/70 border border-red-400/35 text-red-200 font-mono">
              BLOCKERS: {blockersCount}
            </span>
            {reviewCount > 0 && (
              <span className="px-2 py-0.5 rounded bg-amber-950/70 border border-amber-400/35 text-amber-200 font-mono">
                REVIEW: {reviewCount}
              </span>
            )}
          </div>
        </div>

        {/* Warning Strip if warnings exist */}
        {session.warnings.length > 0 && (
          <div className="px-4 sm:px-6 py-2 bg-amber-950/35 border-b border-amber-400/25 text-[11px] text-amber-100 flex items-center gap-2 overflow-x-auto">
            <AlertTriangle className="h-3.5 w-3.5 text-[#E0A458] shrink-0" />
            <span className="truncate">{session.warnings[0]}</span>
            {session.warnings.length > 1 && (
              <button
                type="button"
                onClick={() => setActiveTab('Report')}
                className="shrink-0 underline text-[#E0A458] cursor-pointer"
              >
                +{session.warnings.length - 1} more
              </button>
            )}
          </div>
        )}

        {/* Main Content Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
          {activeTab === 'Chat' && (
            <div className="flex flex-col h-full min-h-[420px]">
              {/* Conversation Stream */}
              <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                {session.chatHistory.map((turn) => (
                  <div
                    key={turn.id}
                    className={`rounded-xl p-3.5 text-xs sm:text-sm leading-relaxed border ${
                      turn.role === 'user'
                        ? 'ml-auto max-w-[85%] bg-[#E0A458]/16 border-[#E0A458]/35 text-white'
                        : 'mr-auto max-w-[92%] bg-white/5 border-white/12 text-white/90'
                    }`}
                  >
                    {turn.role === 'assistant' &&
                      turn.progressSteps &&
                      turn.progressSteps.length > 0 && (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {turn.progressSteps.map((step, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/7 border border-white/12 text-[10px] text-white/70"
                            >
                              <CheckCircle2 className="h-2.5 w-2.5 text-[#E0A458]" />
                              {step}
                            </span>
                          ))}
                        </div>
                      )}

                    <div className="whitespace-pre-line">{turn.text}</div>

                    {turn.role === 'assistant' &&
                      turn.citedRequirements &&
                      turn.citedRequirements.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <span className="text-[10px] uppercase tracking-wider text-white/50">
                            Cited:
                          </span>
                          {turn.citedRequirements.map((reqId) => (
                            <button
                              key={reqId}
                              type="button"
                              onClick={() => setActiveTab('Findings')}
                              className="px-2 py-0.5 rounded bg-[#E0A458]/15 border border-[#E0A458]/35 text-[10px] font-mono text-[#E0A458] hover:bg-[#E0A458]/25 cursor-pointer"
                            >
                              {reqId}
                            </button>
                          ))}
                        </div>
                      )}
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>

              {/* Quick Prompts */}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {QUICK_PROMPTS[language].map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={sendingChat}
                    onClick={() => handleSendChat(prompt)}
                    className="px-2.5 py-1 rounded-full bg-white/6 border border-white/14 text-[11px] text-white/85 hover:bg-white/12 hover:border-[#E0A458]/50 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {prompt}
                  </button>
                ))}
              </div>

              {/* Inline Corrected Evidence Recheck Bar */}
              <div className="mt-3 rounded-xl bg-white/4 border border-white/12 p-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <FileUp className="h-4 w-4 text-[#E0A458]" />
                  <span className="font-medium text-white/90">Recheck Corrected PDF:</span>
                  <select
                    aria-label="Target requirement for corrected PDF"
                    value={correctionTargetReq}
                    onChange={(e) => setCorrectionTargetReq(e.target.value)}
                    className="h-7 rounded-lg bg-[#18151f] border border-white/15 px-2 text-[11px] text-white"
                  >
                    <option value="">Auto-detect by PDF content</option>
                    {session.requirements.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.id} — {r.requirementType}
                      </option>
                    ))}
                  </select>
                  <label className="h-7 px-3 rounded-full bg-white/10 hover:bg-white/18 text-[11px] font-medium text-white inline-flex items-center gap-1.5 cursor-pointer">
                    {uploadingCorrection ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <FileUp className="h-3 w-3 text-[#E0A458]" />
                    )}
                    <span>{uploadingCorrection ? 'Rechecking...' : 'Upload Corrected PDF'}</span>
                    <input
                      ref={correctionFileRef}
                      type="file"
                      accept=".pdf,application/pdf"
                      className="sr-only"
                      disabled={uploadingCorrection}
                      onChange={(e) => handleCorrectedUpload(e.target.files?.[0])}
                    />
                  </label>
                </div>

                {session.mode === 'SAMPLE' && (
                  <a
                    href="/api/sample/corrected-iso.pdf"
                    download="Sample_Renewed_ISO_9001.pdf"
                    className="text-[11px] text-[#E0A458] underline hover:text-[#EBB46B]"
                  >
                    Download Sample Renewed ISO PDF
                  </a>
                )}

                {correctionStatus && (
                  <p className="w-full text-[11px] text-emerald-200">{correctionStatus}</p>
                )}
              </div>

              {/* Chat Errors / Voice Note */}
              {chatError && (
                <p className="mt-2 text-xs text-red-300" role="alert">
                  {chatError}
                </p>
              )}
              {voiceNote && <p className="mt-1.5 text-[11px] text-amber-200/90">{voiceNote}</p>}

              {/* Composer */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSendChat();
                }}
                className="mt-2.5 flex items-center gap-2"
              >
                <button
                  type="button"
                  onClick={toggleVoiceInput}
                  title="Dictate Tamil or English question into editable input"
                  aria-label={listening ? 'Stop voice dictation' : 'Start voice dictation'}
                  className={`h-10 w-10 shrink-0 rounded-full border inline-flex items-center justify-center transition-colors cursor-pointer ${
                    listening
                      ? 'bg-red-600/80 border-red-300 text-white'
                      : 'bg-white/6 border-white/15 text-white/80 hover:bg-white/12'
                  }`}
                >
                  {listening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
                <input
                  type="text"
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  placeholder={
                    language === 'Tam'
                      ? 'தமிழ் அல்லது ஆங்கிலத்தில் கேளுங்கள் (எ.கா. முதலில் எதை சரிசெய்ய வேண்டும்?)...'
                      : 'Ask: "Can we still bid?", "What should I fix first?", "Explain R2", or "I disagree with R2"...'
                  }
                  className="flex-1 h-10 rounded-full bg-white/7 border border-white/16 px-4 text-xs sm:text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-[#E0A458]"
                />
                <button
                  type="submit"
                  disabled={sendingChat || !messageInput.trim()}
                  className="h-10 px-4 rounded-full bg-[#E0A458] hover:bg-[#EBB46B] disabled:opacity-50 text-[#1A1206] text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  {sendingChat ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  <span>Send</span>
                </button>
              </form>
            </div>
          )}

          {activeTab === 'Findings' && (
            <div className="space-y-4">
              {decisionFeedbackMsg && (
                <div className="rounded-xl bg-[#E0A458]/12 border border-[#E0A458]/35 px-4 py-2.5 text-xs text-amber-100">
                  {decisionFeedbackMsg}
                </div>
              )}

              {session.requirements.map((req) => {
                const finding = session.validation.find((v) => v.requirementId === req.id);
                const match = session.matches.find((m) => m.requirementId === req.id);
                const status = finding?.status ?? 'REVIEW_REQUIRED';
                const busy = decisionBusyReq === req.id;

                return (
                  <div
                    key={req.id}
                    className="rounded-xl bg-white/5 border border-white/12 p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-bold text-[#E0A458]">{req.id}</span>
                          <span
                            className={`px-2 py-0.5 rounded border text-[11px] font-mono font-semibold ${STATUS_STYLE[status]}`}
                          >
                            {status}
                          </span>
                          <span className="text-[11px] uppercase tracking-wider text-white/50">
                            {req.requirementType} · {req.sourceDocName} p.{req.sourcePage}
                          </span>
                          {!req.citationVerified && (
                            <span className="text-[10px] px-2 py-0.5 rounded bg-amber-950/70 border border-amber-400/40 text-amber-200">
                              Citation Unverified
                            </span>
                          )}
                        </div>
                        <h3 className="mt-1.5 text-sm font-semibold text-white">
                          {req.officialWording}
                        </h3>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                      <div className="rounded-lg bg-black/30 border border-white/8 p-3">
                        <p className="text-[10px] uppercase tracking-wider text-white/50">
                          Tender Quote
                        </p>
                        <p className="mt-1 text-white/85">"{req.verbatimQuote}"</p>
                      </div>
                      <div className="rounded-lg bg-black/30 border border-white/8 p-3">
                        <p className="text-[10px] uppercase tracking-wider text-white/50">
                          Supplier Evidence Match
                        </p>
                        {match && match.docId ? (
                          <p className="mt-1 text-white/85">
                            <span className="font-medium text-[#E0A458]">
                              {match.docName} (p.{match.page})
                            </span>
                            : "{match.verbatimQuote}"
                          </p>
                        ) : (
                          <p className="mt-1 text-white/55">
                            No verified matching supplier document passage.
                          </p>
                        )}
                      </div>
                    </div>

                    <p className="text-xs leading-relaxed text-white/85">
                      {language === 'Tam' && finding?.explanationTa
                        ? finding.explanationTa
                        : finding?.explanation}
                    </p>

                    {finding && finding.sentinelFlags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {finding.sentinelFlags.map((flag, idx) => (
                          <span
                            key={idx}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-950/60 border border-amber-400/35 text-[11px] text-amber-200"
                          >
                            <ShieldAlert className="h-3 w-3" />
                            {flag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Human Review / Dispute Controls */}
                    <div className="pt-2 border-t border-white/10 flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={decisionNoteByReq[req.id] || ''}
                        onChange={(e) =>
                          setDecisionNoteByReq((prev) => ({ ...prev, [req.id]: e.target.value }))
                        }
                        placeholder="Add review note or dispute reason..."
                        className="flex-1 min-w-[180px] h-8 rounded-lg bg-white/6 border border-white/14 px-2.5 text-xs text-white placeholder:text-white/40"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleDecision(req.id, 'agree')}
                        className="h-8 px-3 rounded-full bg-white/8 hover:bg-white/15 text-[11px] text-white cursor-pointer disabled:opacity-50"
                      >
                        Agree Finding
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleDecision(req.id, 'dispute')}
                        className="h-8 px-3 rounded-full bg-amber-950/60 border border-amber-400/35 hover:bg-amber-900/60 text-[11px] text-amber-100 cursor-pointer disabled:opacity-50"
                      >
                        Dispute
                      </button>
                      {status === 'REVIEW_REQUIRED' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleDecision(req.id, 'approve')}
                          className="h-8 px-3 rounded-full bg-emerald-950/70 border border-emerald-400/40 hover:bg-emerald-900/70 text-[11px] text-emerald-100 cursor-pointer disabled:opacity-50"
                        >
                          Approve After Human Review
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'Rescue' && (
            <div className="space-y-3">
              {session.plan.length === 0 ? (
                <div className="rounded-xl bg-emerald-950/35 border border-emerald-400/35 p-5 text-sm text-emerald-100">
                  No unresolved blockers remain in the Bid Rescue queue. Review the Readiness Report before final submission.
                </div>
              ) : (
                session.plan.map((item) => (
                  <div
                    key={item.requirementId}
                    className="rounded-xl bg-white/5 border border-white/12 p-4 space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="h-6 w-6 rounded-full bg-[#E0A458] text-[#1A1206] text-xs font-bold inline-flex items-center justify-center">
                          {item.priority}
                        </span>
                        <span className="font-mono text-xs text-[#E0A458]">{item.requirementId}</span>
                        <span
                          className={`px-2 py-0.5 rounded border text-[10px] font-mono ${URGENCY_STYLE[item.urgency]}`}
                        >
                          {item.urgency}
                        </span>
                      </div>
                      <span className="text-[11px] text-white/65">
                        Owner: <strong className="text-white">{item.suggestedOwner}</strong> ·{' '}
                        {item.timeRemaining}
                      </span>
                    </div>

                    <h3 className="text-sm font-semibold text-white">
                      {language === 'Tam' ? item.whatToFixTa : item.whatToFix}
                    </h3>
                    <p className="text-xs text-white/80">{item.whyItMatters}</p>
                    <div className="flex flex-wrap gap-3 pt-1 text-[11px] text-white/65">
                      <span>Required: {item.requiredEvidence}</span>
                      <span>
                        Feasibility: <strong className="text-white/90">{item.feasibility}</strong>
                      </span>
                      <span>{item.leadTimeNote}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === 'Report' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/5 border border-white/12 p-4">
                <div>
                  <h3 className="text-sm font-semibold">HTML Bid Readiness Dossier</h3>
                  <p className="text-xs text-white/70 mt-0.5">
                    Includes all requirements, quotes, Sentinel flags, human disputes, audit events, and unresolved blockers.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void downloadReport(session.sessionId).catch((error: Error) => window.alert(error.message))}
                    className="h-9 px-4 rounded-full bg-[#E0A458] hover:bg-[#EBB46B] text-[#1A1206] text-xs font-semibold inline-flex items-center gap-1.5"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download HTML Report</span>
                  </button>
                  <button
                    type="button"
                    onClick={onClearSession}
                    className="h-9 px-3.5 rounded-full border border-white/20 text-xs text-white/80 hover:bg-white/10 cursor-pointer"
                  >
                    Clear Session
                  </button>
                </div>
              </div>

              {/* External Integration Boundaries (honest status) */}
              {integrations && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div className="rounded-xl bg-white/4 border border-white/10 p-3.5">
                    <p className="font-semibold text-white/90">
                      Sarvam AI Voice:{' '}
                      <span className="text-amber-300">
                        {integrations.sarvamVoice.connected ? 'Connected' : 'Not Connected'}
                      </span>
                    </p>
                    <p className="mt-1 text-white/70">{integrations.sarvamVoice.note}</p>
                  </div>
                  <div className="rounded-xl bg-white/4 border border-white/10 p-3.5">
                    <p className="font-semibold text-white/90">
                      n8n Automation:{' '}
                      <span className="text-amber-300">
                        {integrations.n8nAutomation.connected ? 'Connected' : 'Not Connected'}
                      </span>
                    </p>
                    <p className="mt-1 text-white/70">{integrations.n8nAutomation.note}</p>
                  </div>
                </div>
              )}

              {/* Warnings + Audit Trail */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="rounded-xl bg-white/4 border border-white/10 p-3.5 space-y-1.5">
                  <p className="font-semibold text-[#E0A458]">
                    Warnings &amp; Coverage ({session.warnings.length})
                  </p>
                  {session.warnings.length === 0 ? (
                    <p className="text-white/60">No ingestion or coverage warnings.</p>
                  ) : (
                    <ul className="list-disc pl-4 space-y-1 text-white/80">
                      {session.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded-xl bg-white/4 border border-white/10 p-3.5 space-y-1.5 max-h-52 overflow-y-auto">
                  <p className="font-semibold text-[#E0A458]">
                    Audit Trail ({session.audit_events.length})
                  </p>
                  {session.audit_events.map((ev) => (
                    <div key={ev.id} className="text-[11px] text-white/80 border-b border-white/8 pb-1">
                      <span className="font-mono text-white/55">[{ev.actor}]</span>{' '}
                      <strong>{ev.action}</strong>: {ev.detail}
                    </div>
                  ))}
                </div>
              </div>

              {/* Sandboxed HTML Report Preview */}
              <div className="rounded-xl border border-white/12 overflow-hidden bg-white">
                {reportLoading ? (
                  <div className="p-6 text-xs text-slate-700 flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Rendering readiness report preview...</span>
                  </div>
                ) : reportHtml ? (
                  <iframe
                    title="Namma Tender Bid Readiness Report Preview"
                    srcDoc={reportHtml}
                    sandbox=""
                    className="w-full h-[360px] border-0"
                  />
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
