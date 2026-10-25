import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Bot, Sparkles, Send, X, AlertCircle, RefreshCw,
  BookOpen, ExternalLink, ArrowRight,
  Cpu, Layers
} from 'lucide-react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../../utils/api';

const QUICK_STARTERS = [
  'How should I approach this milestone?',
  'What are common errors or pitfalls here?',
  'Help me debug my current deliverable',
  'Recommend a relevant Skills Hub resource'
];

export default function ProjectMentorModal({
  isOpen,
  onClose,
  activeProgress,
  activeTemplate,
  moduleIndex,
  currentSubmissionContent = ''
}) {
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState('');
  const [includeDraft, setIncludeDraft] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [configReason, setConfigReason] = useState(null);
  const [errorBanner, setErrorBanner] = useState(null);

  const messagesEndRef = useRef(null);

  const currentModule = activeTemplate?.modules?.find((m) => m.moduleIndex === moduleIndex);
  const milestoneNumber = moduleIndex !== null && moduleIndex !== undefined ? moduleIndex + 1 : 1;

  const fetchSessionHistory = useCallback(async () => {
    if (!activeProgress?._id || moduleIndex === null || moduleIndex === undefined) return;
    setLoadingHistory(true);
    setErrorBanner(null);
    try {
      const res = await api.get(
        `/build-paths/progress/${activeProgress._id}/modules/${moduleIndex}/mentor`
      );

      if (res.data) {
        setConfigured(Boolean(res.data.configured));
        setConfigReason(res.data.reason || null);
        setMessages(res.data.messages || []);
      }
    } catch (err) {
      if (err.response?.status === 503) {
        setConfigured(false);
        setConfigReason(err.response?.data?.message || 'Agent37 instance is not configured.');
      } else {
        console.warn('Could not load mentor session history:', err);
      }
    } finally {
      setLoadingHistory(false);
    }
  }, [activeProgress?._id, moduleIndex]);

  useEffect(() => {
    if (isOpen) {
      fetchSessionHistory();
    }
  }, [isOpen, fetchSessionHistory]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleSendMessage = async (textToSend) => {
    const messageContent = (textToSend || inputMessage).trim();
    if (!messageContent || sending) return;

    setErrorBanner(null);
    setSending(true);

    // Optimistically add user message
    const optimisticUserMsg = {
      role: 'user',
      content: messageContent,
      timestamp: new Date().toISOString()
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);
    setInputMessage('');

    try {
      const payload = {
        message: messageContent,
        submissionContent: includeDraft && currentSubmissionContent ? currentSubmissionContent : null
      };

      const res = await api.post(
        `/build-paths/progress/${activeProgress._id}/modules/${moduleIndex}/mentor`,
        payload
      );

      if (res.data?.success) {
        if (Array.isArray(res.data.messages)) {
          setMessages(res.data.messages);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: res.data.answer,
              recommendedResource: res.data.recommendedResource,
              timestamp: new Date().toISOString()
            }
          ]);
        }
      } else {
        throw new Error(res.data?.message || 'Failed to get mentor response');
      }
    } catch (err) {
      const status = err.response?.status;
      const errMsg = err.response?.data?.message || err.message || 'Mentor request failed';

      if (status === 503) {
        setConfigured(false);
        setConfigReason(errMsg);
      } else {
        setErrorBanner(errMsg);
        toast.error(errMsg);
      }
    } finally {
      setSending(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-black/85 backdrop-blur-md">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          className="relative w-full max-w-4xl max-h-[92vh] flex flex-col bg-surface/95 border border-primary/30 rounded-3xl shadow-[0_0_60px_rgba(0,0,0,0.8)] overflow-hidden"
        >
          {/* ── Modal Header ── */}
          <div className="p-4 md:p-5 border-b border-white/10 flex items-center justify-between bg-white/[0.02]">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center text-primary shadow-[0_0_15px_rgba(var(--primary),0.3)]">
                <Bot size={22} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-bold text-white">AI Project Mentor</h3>
                  <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 flex items-center gap-1">
                    <Cpu size={10} /> Agent37
                  </span>
                </div>
                <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5 flex-wrap">
                  <span>Assisting with:</span>
                  <span className="text-primary font-semibold">
                    Milestone #{milestoneNumber} — {currentModule?.title || 'Current Milestone'}
                  </span>
                </div>
              </div>
            </div>

            <button
              onClick={onClose}
              className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
              title="Close Mentor"
            >
              <X size={20} />
            </button>
          </div>

          {/* ── Context Ribbon ── */}
          <div className="px-5 py-2.5 bg-primary/5 border-b border-primary/10 flex items-center justify-between text-xs text-gray-300">
            <div className="flex items-center gap-2 truncate">
              <Layers size={14} className="text-primary shrink-0" />
              <span className="text-gray-400">Project:</span>
              <span className="font-semibold text-white truncate">
                {activeTemplate?.projectIdea || 'Current Build Path'}
              </span>
            </div>
            {currentSubmissionContent && (
              <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer select-none shrink-0 ml-3">
                <input
                  type="checkbox"
                  checked={includeDraft}
                  onChange={(e) => setIncludeDraft(e.target.checked)}
                  className="rounded border-white/20 text-primary focus:ring-0 cursor-pointer"
                />
                <span>Attach my draft code</span>
              </label>
            )}
          </div>

          {/* ── Chat Messages Body ── */}
          <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
            {/* Unconfigured State Banner */}
            {!configured && (
              <motion.div
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-5 rounded-2xl bg-amber-500/10 border border-amber-500/30 space-y-3"
              >
                <div className="flex items-center gap-2 text-amber-300 font-bold text-sm">
                  <AlertCircle size={18} />
                  Agent37 Instance Configuration Required
                </div>
                {configReason && (
                  <div className="text-xs text-amber-200/90 font-medium">
                    Status: {configReason}
                  </div>
                )}
                <p className="text-xs text-gray-300 leading-relaxed">
                  The AI Project Mentor runs on an isolated Agent37 cloud agent instance. To activate live guidance in this environment, configure your Agent37 credentials in the backend <code className="bg-white/10 px-1.5 py-0.5 rounded text-white font-mono text-[11px]">.env</code>:
                </p>
                <div className="p-3 bg-black/60 rounded-xl border border-white/10 font-mono text-xs text-emerald-400 space-y-1">
                  <div>AGENT37_ENABLED=true</div>
                  <div>AGENT37_API_KEY=sk_live_your_key_here</div>
                  <div>AGENT37_INSTANCE_URL=https://&lt;your-instance-id&gt;.agent37.app</div>
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
                  <a
                    href="https://www.agent37.com/cloud"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline font-semibold"
                  >
                    <ExternalLink size={12} /> Agent37 Cloud Dashboard
                  </a>
                  <a
                    href="https://hackyard.org/build2026/agent37"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-cyan-400 hover:underline font-semibold"
                  >
                    <ExternalLink size={12} /> Hackyard Agent37 Challenge
                  </a>
                </div>
              </motion.div>
            )}

            {/* Welcome Message */}
            {loadingHistory && (
              <div className="flex items-center justify-center p-3 text-xs text-gray-400 gap-2">
                <RefreshCw size={14} className="animate-spin text-primary" />
                <span>Loading mentor session history...</span>
              </div>
            )}
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center text-primary shrink-0 mt-0.5">
                <Sparkles size={16} />
              </div>
              <div className="p-4 rounded-2xl rounded-tl-sm bg-surface/90 border border-white/10 text-xs text-gray-200 leading-relaxed max-w-2xl space-y-2">
                <p className="font-semibold text-white">
                  Hello! I am your AI Project Mentor, powered by Agent37.
                </p>
                <p>
                  I'm ready to help you navigate{' '}
                  <span className="text-primary font-bold">
                    Milestone #{milestoneNumber}: {currentModule?.title}
                  </span>
                  . I can diagnose tricky bugs, explain underlying architectures, and recommend relevant learning resources from EduVerse's Skills Hub.
                </p>
                <p className="text-gray-400 text-[11px]">
                  What are you currently stuck on, or what concept would you like to explore?
                </p>
              </div>
            </div>

            {/* Conversation History */}
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex items-start gap-3 ${
                  msg.role === 'user' ? 'flex-row-reverse' : ''
                }`}
              >
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                    msg.role === 'user'
                      ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30 font-bold text-xs'
                      : 'bg-primary/20 text-primary border border-primary/30'
                  }`}
                >
                  {msg.role === 'user' ? 'You' : <Bot size={16} />}
                </div>

                <div
                  className={`p-4 rounded-2xl text-xs leading-relaxed max-w-2xl space-y-3 ${
                    msg.role === 'user'
                      ? 'rounded-tr-sm bg-purple-500/15 border border-purple-500/30 text-white'
                      : 'rounded-tl-sm bg-surface/90 border border-white/10 text-gray-200'
                  }`}
                >
                  {/* Message content */}
                  <div className="whitespace-pre-wrap">{msg.content}</div>

                  {/* Recommended Learning Resource Link (Phase 6) */}
                  {msg.role === 'assistant' && msg.recommendedResource && (
                    <div className="pt-3 border-t border-white/10">
                      <div className="p-3.5 rounded-xl bg-primary/10 border border-primary/25 space-y-2">
                        <div className="flex items-center gap-1.5 text-primary font-bold text-[11px] uppercase tracking-wider">
                          <BookOpen size={13} /> Recommended Next Learning Step:
                        </div>
                        <div className="text-xs font-semibold text-white">
                          {msg.recommendedResource.title}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          {msg.recommendedResource.skillId ? (
                            <Link
                              to={`/skills/${msg.recommendedResource.skillId}/learn`}
                              onClick={onClose}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-black font-bold text-xs hover:bg-primary/90 transition-all cursor-pointer"
                            >
                              <BookOpen size={13} />
                              Open in Skills Hub
                              <ArrowRight size={13} />
                            </Link>
                          ) : msg.recommendedResource.url ? (
                            <a
                              href={msg.recommendedResource.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-black font-bold text-xs hover:bg-primary/90 transition-all cursor-pointer"
                            >
                              <ExternalLink size={13} />
                              {msg.recommendedResource.label || 'View Resource'}
                            </a>
                          ) : (
                            <Link
                              to="/skills"
                              onClick={onClose}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-black font-bold text-xs hover:bg-primary/90 transition-all cursor-pointer"
                            >
                              <BookOpen size={13} />
                              Explore Skills Hub
                              <ArrowRight size={13} />
                            </Link>
                          )}
                          <span className="text-[11px] text-gray-400">
                            (Study the concept, then return here to retry)
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Sending indicator */}
            {sending && (
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center text-primary shrink-0 mt-0.5">
                  <Bot size={16} />
                </div>
                <div className="p-4 rounded-2xl rounded-tl-sm bg-surface/90 border border-white/10 text-xs text-gray-300 flex items-center gap-2">
                  <RefreshCw size={14} className="animate-spin text-primary" />
                  <span>Agent37 AI Project Mentor is thinking and evaluating context...</span>
                </div>
              </div>
            )}

            {/* Error Banner */}
            {errorBanner && (
              <div className="p-3 rounded-xl bg-red-500/15 border border-red-500/30 text-xs text-red-300 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <AlertCircle size={15} className="shrink-0" />
                  <span>{errorBanner}</span>
                </div>
                <button
                  onClick={() => handleSendMessage(inputMessage)}
                  className="px-2.5 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-white font-bold text-[11px] transition-all cursor-pointer"
                >
                  Retry
                </button>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* ── Quick Prompts ── */}
          <div className="px-4 py-2 border-t border-white/5 bg-white/[0.01] flex items-center gap-2 overflow-x-auto">
            <span className="text-[11px] text-gray-500 shrink-0 flex items-center gap-1">
              <Sparkles size={11} className="text-primary" /> Quick asks:
            </span>
            {QUICK_STARTERS.map((promptText, i) => (
              <button
                key={i}
                type="button"
                disabled={sending}
                onClick={() => handleSendMessage(promptText)}
                className="text-[11px] text-gray-300 bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/15 px-2.5 py-1 rounded-lg shrink-0 transition-all cursor-pointer disabled:opacity-50"
              >
                {promptText}
              </button>
            ))}
          </div>

          {/* ── Input Bar ── */}
          <div className="p-4 border-t border-white/10 bg-surface">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="flex items-end gap-2"
            >
              <div className="flex-1 relative">
                <textarea
                  rows={2}
                  value={inputMessage}
                  onChange={(e) => setInputMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSendMessage();
                    }
                  }}
                  placeholder="Ask a question or explain your error for this milestone... (Press Enter to send)"
                  className="w-full bg-black/40 border border-white/10 rounded-2xl p-3 text-xs text-white placeholder-gray-500 outline-none focus:border-primary transition-all resize-none shadow-inner"
                  maxLength={2000}
                />
                <div className="absolute bottom-2 right-3 text-[10px] text-gray-500 font-mono">
                  {inputMessage.length}/2000
                </div>
              </div>

              <button
                type="submit"
                disabled={sending || !inputMessage.trim()}
                className="px-4 py-3 bg-primary hover:bg-primary/90 disabled:opacity-40 text-black font-black text-xs rounded-2xl transition-all shadow-[0_0_15px_rgba(var(--primary),0.3)] flex items-center gap-1.5 cursor-pointer shrink-0"
              >
                {sending ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Send size={14} />
                )}
                <span>Ask Mentor</span>
              </button>
            </form>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
