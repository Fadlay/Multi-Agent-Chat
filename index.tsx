import React, { useState, useEffect, useRef, FormEvent, FC, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
// Fix: Import Modality for image editing model configuration.
import { GoogleGenAI, Content, Part, Modality } from '@google/genai';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Fix: Add a minimal interface for the SpeechRecognition API to resolve TypeScript type errors.
interface SpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: (event: any) => void;
  onerror: (event: any) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}

const INITIAL_SYSTEM_INSTRUCTION = "You are an expert-level AI assistant. Your task is to provide a comprehensive, accurate, and well-reasoned initial response to the user's query. Aim for clarity and depth. Note: Your response is an intermediate step for other AI agents and will not be shown to the user. Be concise and focus on core information without unnecessary verbosity.";
const REFINEMENT_SYSTEM_INSTRUCTION = "You are a reflective AI agent. Your primary task is to find flaws. Critically analyze your previous response and the responses from other AI agents. Focus specifically on identifying factual inaccuracies, logical fallacies, omissions, or any other weaknesses. Your goal is to generate a new, revised response that corrects these specific errors and is free from the flaws you have identified. Note: This refined response is for a final synthesizer agent, not the user, so be direct and prioritize accuracy over conversational style.";
const SYNTHESIZER_SYSTEM_INSTRUCTION = "You are a master synthesizer AI. Your PRIMARY GOAL is to write the final, complete response to the user's query. You will be given the user's query and four refined responses from other AI agents. Your task is to analyze these responses—identifying their strengths to incorporate and their flaws to discard. Use this analysis to construct the single best possible answer for the user. Do not just critique the other agents; your output should BE the final, polished response.";
const MEMORY_AGENT_SYSTEM_INSTRUCTION = "You are a memory management AI. Your task is to analyze the user's latest message in the context of the conversation. Identify and extract ONLY crucial, long-term facts about the user (e.g., name, preferences, goals, key life details). Do NOT extract trivial information. If important new information is found, output it as a concise statement. If the user explicitly asks you to remember something, save it. If no new important information is found or the user's message is trivial, output the exact string 'NO_UPDATE'.";

interface Message {
  role: 'user' | 'model';
  parts: Part[];
  // Fix: Add a 'file' property to hold the raw File object for user messages, avoiding storing large base64 strings in state.
  file?: File;
  memoryUpdated?: boolean;
  attachmentName?: string;
  groundingChunks?: any[];
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
}

const WelcomeModal: FC<{ 
  isOpen: boolean;
  onClose: () => void;
}> = ({ isOpen, onClose }) => {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleClose = () => {
    if (dontShowAgain) {
      localStorage.setItem('hideWelcomeModal', 'true');
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={handleClose} role="dialog" aria-modal="true" aria-labelledby="welcome-modal-title">
      <div className="modal-content welcome-modal" onClick={e => e.stopPropagation()}>
        <h2 id="welcome-modal-title">Welcome to Multi-Agent Chat by Fadlay!</h2>
        <p>This isn't your typical chatbot. Here's a quick look at the powerful features at your disposal:</p>
        <ul className="features-list">
            <li><strong>🧠 Multi-Agent System:</strong> Your prompts are processed by a team of AI agents that collaborate, critique, and refine their answers to give you the most comprehensive response.</li>
            <li><strong>📝 Smart Memory:</strong> The AI can remember key details about you across conversations. Manage what it remembers using the settings icon (⚙️).</li>
            <li><strong>📎 File Attachments:</strong> Attach images, documents, and other files for the agents to analyze and discuss.</li>
            <li><strong>🖼️ Image Editing:</strong> Switch to the "Image Preview" model to edit images with text prompts.</li>
            <li><strong>⚠️ API Usage Note:</strong> The multi-agent system makes multiple calls per prompt, which can consume your API rate limit quickly.</li>
        </ul>
        <div className="modal-footer">
          <div className="checkbox-container">
            <input 
              type="checkbox" 
              id="dont-show-again" 
              checked={dontShowAgain} 
              onChange={(e) => setDontShowAgain(e.target.checked)} 
            />
            <label htmlFor="dont-show-again">Don't show this again</label>
          </div>
          <button onClick={handleClose} className="button-primary">Get Started</button>
        </div>
      </div>
    </div>
  );
};

const ConfirmationModal: FC<{ 
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  children: ReactNode;
}> = ({ isOpen, onClose, onConfirm, title, children }) => {
  if (!isOpen) return null;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h2 id="modal-title">{title}</h2>
        <p>{children}</p>
        <div className="modal-actions">
          <button onClick={onClose} className="button-secondary">Cancel</button>
          <button onClick={onConfirm} className="button-danger">Delete</button>
        </div>
      </div>
    </div>
  );
};

const MemoryModal: FC<{ 
  isOpen: boolean;
  onClose: () => void;
  onSave: (memory: string[], apiKey: string) => void;
  memory: string[];
  apiKey: string;
}> = ({ isOpen, onClose, onSave, memory, apiKey }) => {
  const [editedMemory, setEditedMemory] = useState(memory.join('\n'));
  const [editedApiKey, setEditedApiKey] = useState(apiKey);
  const [isApiKeyVisible, setIsApiKeyVisible] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);

  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setIsFullScreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
        setIsFullScreen(false);
      }
    }
  };

  useEffect(() => {
    if (isOpen) {
      setEditedMemory(memory.join('\n'));
      setEditedApiKey(apiKey);
    }
  }, [isOpen, memory, apiKey]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSave = () => {
    const memoryArray = editedMemory.split('\n').map(m => m.trim()).filter(Boolean);
    onSave(memoryArray, editedApiKey);
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="memory-modal-title">
      <div className="modal-content wide-modal" onClick={e => e.stopPropagation()}>
        <h2 id="memory-modal-title">Memory & Settings</h2>
        <div className="settings-section">
          <h3>Gemini API Key</h3>
          <p className="api-disclaimer"><strong>Important:</strong> This app's multi-agent system makes several API calls per message, consuming your API quota faster than normal. For heavy use, consider requesting a quota increase.</p>
          <p>Enter your own Gemini API key to use the app. Your key is stored locally and never shared.</p>
          <div className="api-key-input-wrapper">
            <input
              type={isApiKeyVisible ? 'text' : 'password'}
              className="api-key-input"
              value={editedApiKey}
              onChange={(e) => setEditedApiKey(e.target.value)}
              placeholder="Enter your Gemini API Key"
              aria-label="Gemini API Key"
            />
            <button 
              type="button"
              className="peek-button"
              onClick={() => setIsApiKeyVisible(!isApiKeyVisible)}
              aria-label={isApiKeyVisible ? 'Hide API Key' : 'Show API Key'}
            >
              {isApiKeyVisible ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        <div className="settings-section">
          <h3>User Memory</h3>
          <p>Edit the information the AI remembers about you. Each line is a separate memory point.</p>
          <textarea
            className="memory-textarea"
            value={editedMemory}
            onChange={(e) => setEditedMemory(e.target.value)}
            rows={10}
            aria-label="User memory content"
          />
        </div>
        <div className="modal-actions">
          <button onClick={onClose} className="button-secondary">Cancel</button>
          <button onClick={handleSave} className="button-primary">Save Changes</button>
        </div>
        <div className="fullscreen-button-container">
            <button onClick={toggleFullScreen} className="icon-button fullscreen-button" aria-label="Toggle fullscreen" title="Toggle fullscreen">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                </svg>
            </button>
        </div>
      </div>
    </div>
  );
};

const CodeBlock: FC<{ children?: ReactNode }> = ({ children }) => {
  const [copied, setCopied] = useState(false);
  const textToCopy = String(children).replace(/\n$/, '');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  return (
    <div className="code-block-wrapper">
      <pre><code>{children}</code></pre>
      <button onClick={handleCopy} className="copy-button" aria-label="Copy code">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
          {copied ? (
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
          ) : (
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-5zm0 16H8V7h11v14z"/>
          )}
        </svg>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
};

const LoadingIndicator: FC<{ status: string; time: number }> = ({ status, time }) => {
    const getStatusClass = (status: string) => {
        if (status.startsWith('Initializing')) return 'initial';
        if (status.startsWith('Refining')) return 'refining';
        if (status.startsWith('Synthesizing')) return 'synthesizing';
        return 'initial';
    };

    const isNanoBanana = status === 'Nano banana';

    return (
      <div className="loading-animation">
        <div className="loading-header">
          <span className="loading-status">{status}</span>
          <span className="timer-display">{(time / 1000).toFixed(1)}s</span>
        </div>
        {isNanoBanana ? (
          <div className="progress-bars-container nano-banana">
            <div className="progress-bar"></div>
          </div>
        ) : (
          <div className={`progress-bars-container ${getStatusClass(status)}`}>
            <div className="progress-bar"></div>
            <div className="progress-bar"></div>
            <div className="progress-bar"></div>
            <div className="progress-bar"></div>
          </div>
        )}
      </div>
    );
};

const ThemeToggle: FC<{ theme: 'light' | 'dark'; toggleTheme: () => void }> = ({ theme, toggleTheme }) => {
  const label = `Switch to ${theme === 'light' ? 'dark' : 'light'} mode`;
  return (
    <button onClick={toggleTheme} className="icon-button" aria-label={label} title={label}>
      {theme === 'light' ? (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
        </svg>
      )}
    </button>
  );
};

const groupChatsByDate = (chats: ChatSession[]): Record<string, ChatSession[]> => {
    const groups: Record<string, ChatSession[]> = {};
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    chats.forEach(chat => {
        const chatDate = new Date(parseInt(chat.id, 10));
        const diffDays = Math.round((today.getTime() - new Date(chatDate.getFullYear(), chatDate.getMonth(), chatDate.getDate()).getTime()) / (1000 * 60 * 60 * 24));
        
        let groupName: string;
        if (diffDays === 0) groupName = "Today";
        else if (diffDays === 1) groupName = "Yesterday";
        else if (diffDays <= 7) groupName = "Previous 7 Days";
        else if (diffDays <= 30) groupName = "Previous 30 Days";
        else groupName = "Older";

        if (!groups[groupName]) {
            groups[groupName] = [];
        }
        groups[groupName].push(chat);
    });

    return groups;
};


const SearchModal: FC<{
    isOpen: boolean;
    onClose: () => void;
    searchQuery: string;
    onSearchChange: (query: string) => void;
    results: ChatSession[];
    onSelectChat: (id: string) => void;
}> = ({ isOpen, onClose, searchQuery, onSearchChange, results, onSelectChat }) => {
    
    useEffect(() => {
      if (!isOpen) return;
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          onClose();
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);
    
    if (!isOpen) return null;

    const handleSelect = (chatId: string) => {
        onSelectChat(chatId);
        onClose();
    };
    
    const groupedResults = groupChatsByDate(results);
    const groupOrder = ["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Older"];

    return (
        <div className="search-modal-backdrop" onClick={onClose}>
            <div className="search-modal-content" onClick={e => e.stopPropagation()}>
                <div className="search-modal-header">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                    </svg>
                    <input
                        type="search"
                        placeholder="Search chats..."
                        value={searchQuery}
                        onChange={(e) => onSearchChange(e.target.value)}
                        autoFocus
                        aria-label="Search chat history"
                    />
                    <button onClick={onClose} className="icon-button close-search-button" aria-label="Close search">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                    </button>
                </div>
                <div className="search-results-list">
                    {results.length > 0 ? (
                        groupOrder.map(groupName => (
                            groupedResults[groupName] && (
                                <div key={groupName} className="search-results-group">
                                    <div className="search-group-header">{groupName}</div>
                                    {groupedResults[groupName].map(chat => (
                                        <div
                                            key={chat.id}
                                            className="search-result-item"
                                            onClick={() => handleSelect(chat.id)}
                                            role="button"
                                            tabIndex={0}
                                        >
                                            <div className="search-result-icon">
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                                            </div>
                                            <span className="search-result-title">{chat.title}</span>
                                        </div>
                                    ))}
                                </div>
                            )
                        ))
                    ) : (
                        searchQuery && <div className="no-results">No results for "{searchQuery}"</div>
                    )}
                </div>
            </div>
        </div>
    );
};


const Sidebar: FC<{
  chats: ChatSession[];
  activeChatId: string | null;
  onNewChat: () => void;
  onSelectChat: (id: string) => void;
  onDeleteChat: (e: React.MouseEvent, id: string) => void;
  editingChatId: string | null;
  tempTitle: string;
  onTempTitleChange: (title: string) => void;
  onStartEditing: (id: string, currentTitle: string) => void;
  onSaveTitle: (id: string) => void;
  onCancelEditing: () => void;
  onOpenSearch: () => void;
}> = ({
  chats,
  activeChatId,
  onNewChat,
  onSelectChat,
  onDeleteChat,
  editingChatId,
  tempTitle,
  onTempTitleChange,
  onStartEditing,
  onSaveTitle,
  onCancelEditing,
  onOpenSearch,
}) => (
  <aside className="sidebar">
    <div className="sidebar-header">
      <button onClick={onNewChat} className="new-chat-button">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        <span>New Chat</span>
      </button>
    </div>
    <button className="search-button" onClick={onOpenSearch}>
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
      </svg>
      <span>Search chats</span>
    </button>
    <nav className="history-list">
      {chats.map(chat => (
        <div
          key={chat.id}
          className={`history-item ${chat.id === activeChatId ? 'active' : ''}`}
          onClick={() => editingChatId !== chat.id && onSelectChat(chat.id)}
          role="button"
          tabIndex={editingChatId !== chat.id ? 0 : -1}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelectChat(chat.id); }}
        >
          {editingChatId === chat.id ? (
            <>
              <input
                type="text"
                value={tempTitle}
                onChange={(e) => onTempTitleChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onSaveTitle(chat.id);
                  if (e.key === 'Escape') onCancelEditing();
                }}
                autoFocus
                onFocus={(e) => e.target.select()}
                className="history-title-input"
                aria-label="Edit chat title"
                onClick={(e) => e.stopPropagation()}
              />
              <div className="history-item-actions">
                <button
                  onClick={(e) => { e.stopPropagation(); onSaveTitle(chat.id); }}
                  className="icon-button save-chat-button"
                  aria-label="Save title"
                  title="Save title"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onCancelEditing(); }}
                  className="icon-button cancel-chat-button"
                  aria-label="Cancel edit"
                  title="Cancel edit"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="history-title">{chat.title}</span>
              <div className="history-item-actions">
                <button
                  onClick={(e) => { e.stopPropagation(); onStartEditing(chat.id, chat.title); }}
                  className="icon-button edit-chat-button"
                  aria-label={`Edit title for ${chat.title}`}
                  title="Edit title"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" /></svg>
                </button>
                <button
                  onClick={(e) => onDeleteChat(e, chat.id)}
                  className="icon-button delete-chat-button"
                  aria-label={`Delete chat: ${chat.title}`}
                  title="Delete chat"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </nav>
  </aside>
);

const AttachmentPreview: FC<{ file: File; onRemove: () => void }> = ({ file, onRemove }) => {
  let previewContent;
  const fileUrl = URL.createObjectURL(file);

  if (file.type.startsWith('image/')) {
    previewContent = <img src={fileUrl} alt={file.name} className="preview-thumbnail" />;
  } else if (file.type.startsWith('video/')) {
    previewContent = <div className="preview-icon">📹</div>;
  } else if (file.type.startsWith('audio/')) {
    previewContent = <div className="preview-icon">🎵</div>;
  } else {
    previewContent = <div className="preview-icon">📄</div>;
  }
  
  useEffect(() => {
    return () => URL.revokeObjectURL(fileUrl);
  }, [fileUrl]);

  return (
    <div className="attachment-preview">
      {previewContent}
      <div className="file-info">
        <span className="file-name" title={file.name}>{file.name}</span>
        <span className="file-size">{(file.size / 1024).toFixed(1)} KB</span>
      </div>
      <button onClick={onRemove} className="remove-attachment-button" aria-label="Remove attachment" title="Remove attachment">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
      </button>
    </div>
  );
};

// Helper to convert base64 to a Blob for safe downloading
const b64toBlob = (b64Data: string, contentType = '', sliceSize = 512) => {
  const byteCharacters = atob(b64Data);
  const byteArrays = [];
  for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
    const slice = byteCharacters.slice(offset, offset + sliceSize);
    const byteNumbers = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      byteNumbers[i] = slice.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    byteArrays.push(byteArray);
  }
  const blob = new Blob(byteArrays, { type: contentType });
  return blob;
};

const MessageContent: FC<{ parts: Part[]; file?: File; attachmentName?: string }> = ({ parts, file, attachmentName }) => {
  const handleDownload = (mimeType: string, base64Data: string, fileName: string) => {
    try {
      const blob = b64toBlob(base64Data, mimeType);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link); // Required for Firefox
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Download failed:", error);
    }
  };

  const fileUrl = file ? URL.createObjectURL(file) : null;
  useEffect(() => {
    if (fileUrl) {
      return () => URL.revokeObjectURL(fileUrl);
    }
  }, [fileUrl]);

  const renderFile = (fileToRender: File, url: string) => {
    const name = attachmentName || fileToRender.name;
    if (fileToRender.type.startsWith('image/')) {
      return <img src={url} alt={name} className="message-media" />;
    }
    if (fileToRender.type.startsWith('video/')) {
      return <video src={url} controls className="message-media" />;
    }
    if (fileToRender.type.startsWith('audio/')) {
      return <audio src={url} controls className="message-media-audio" />;
    }
    return (
      <a href={url} download={name} className="message-download" title={`Download ${name}`}>
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
        <span>Download {name}</span>
      </a>
    );
  };

  return (
    <>
      {file && fileUrl && renderFile(file, fileUrl)}
      {parts.map((part, index) => {
        if ('text' in part && part.text) {
          return (
            <ReactMarkdown
              key={index}
              remarkPlugins={[remarkGfm]}
              components={{ code(props) { return <CodeBlock>{String(props.children)}</CodeBlock>; } }}
            >
              {part.text}
            </ReactMarkdown>
          );
        }
        if ('inlineData' in part) {
          const { mimeType, data } = part.inlineData;
          if (mimeType.startsWith('image/')) {
            const src = `data:${mimeType};base64,${data}`;
            return <img key={index} src={src} alt="Uploaded content" className="message-media" />;
          }
          if (mimeType.startsWith('video/')) {
            const src = `data:${mimeType};base64,${data}`;
            return <video key={index} src={src} controls className="message-media" />;
          }
          if (mimeType.startsWith('audio/')) {
             const src = `data:${mimeType};base64,${data}`;
            return <audio key={index} src={src} controls className="message-media-audio" />;
          }
          const fileName = attachmentName || `download.${mimeType.split('/')[1] || 'bin'}`;
          return (
            <a
              key={index}
              href="#"
              onClick={(e) => {
                e.preventDefault();
                handleDownload(mimeType, data, fileName);
              }}
              className="message-download"
              title={`Download ${fileName}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              <span>Download {fileName}</span>
            </a>
          );
        }
        return null;
      })}
    </>
  );
};

const DragDropOverlay: FC = () => (
    <div className="drag-drop-overlay">
      <div className="drag-drop-content">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z" />
        </svg>
        <span>Drop file to attach</span>
      </div>
    </div>
);

const GroundingCitations: FC<{ chunks: any[] }> = ({ chunks }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    if (!chunks || chunks.length === 0) return null;

    const validChunks = chunks.filter(chunk => chunk.web && chunk.web.uri && chunk.web.title);

    if (validChunks.length === 0) return null;

    return (
        <div className="citations-container">
            <button onClick={() => setIsExpanded(!isExpanded)} className="citations-header" aria-expanded={isExpanded}>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
                </svg>
                <span>Sources</span>
                <svg className={`chevron ${isExpanded ? 'expanded' : ''}`} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
            </button>
            {isExpanded && (
                <ol className="citations-list">
                    {validChunks.map((chunk, index) => (
                        <li key={index}>
                            <a href={chunk.web.uri} target="_blank" rel="noopener noreferrer" title={chunk.web.uri}>
                                {chunk.web.title}
                            </a>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
};

const ApiKeyPrompt: FC<{ onSettingsClick: () => void }> = ({ onSettingsClick }) => {
  return (
    <div className="api-key-prompt">
      <p>
        Please enter your Gemini API key in the{' '}
        <button onClick={onSettingsClick} className="settings-link">
          settings
        </button>{' '}
        to begin.
      </p>
      <p>
        You can get your API key from{' '}
        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer">
          Google AI Studio
        </a>
        .
      </p>
    </div>
  );
};

const WelcomeMessage: FC = () => {
    return (
        <div className="welcome-content">
            <h2>Welcome!</h2>
            <p>Start a conversation with the multi-agent system.</p>
        </div>
    );
};

const App: FC = () => {
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingStatus, setLoadingStatus] = useState<string>('');
  const [timer, setTimer] = useState<number>(0);
  const [isSidebarOpen, setIsSidebarOpen] = useState(window.innerWidth > 768);
  const [chatToDelete, setChatToDelete] = useState<string | null>(null);
  const [memory, setMemory] = useState<string[]>([]);
  const [isMemoryModalOpen, setIsMemoryModalOpen] = useState(false);
  const [isWelcomeModalOpen, setIsWelcomeModalOpen] = useState(false);
  const [model, setModel] = useState<string>('gemini-1.5-flash');
  const [apiKey, setApiKey] = useState<string>('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  const [attachment, setAttachment] = useState<File | null>(null);
  const [userInput, setUserInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeechSupported, setIsSpeechSupported] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [editingChatId, setEditingChatId] = useState<string | null>(null);
  const [tempTitle, setTempTitle] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isGroundingEnabled, setIsGroundingEnabled] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const dragCounter = useRef(0);
  const messageListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeChat = chats.find(c => c.id === activeChatId);
  const isNanoBananaModel = model === 'gemini-2.5-flash-image-preview';

  useEffect(() => {
    if (isNanoBananaModel) {
      setIsGroundingEnabled(false);
    }
  }, [model]);
  
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current++;
        if (e.dataTransfer?.items?.length > 0) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter.current--;
        if (dragCounter.current === 0) {
            setIsDragging(false);
        }
    };

    const handleDragOver = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    const handleDrop = (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        dragCounter.current = 0;

        if (isLoading) return; // Don't handle drops while loading

        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            setAttachment(e.dataTransfer.files[0]);
            e.dataTransfer.clearData();
        }
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);

    return () => {
        window.removeEventListener('dragenter', handleDragEnter);
        window.removeEventListener('dragleave', handleDragLeave);
        window.removeEventListener('dragover', handleDragOver);
        window.removeEventListener('drop', handleDrop);
    };
  }, [isLoading]);

  useEffect(() => {
    // Note: Storing raw File objects in localStorage is not possible.
    // This implementation rehydrates chat history without file content on page load.
    // A more robust solution would use IndexedDB for session persistence.
    const hideWelcome = localStorage.getItem('hideWelcomeModal') === 'true';
    if (!hideWelcome) {
      setIsWelcomeModalOpen(true);
    }
    const savedChats = localStorage.getItem('chatHistory');
    const savedActiveId = localStorage.getItem('activeChatId');
    const savedMemory = localStorage.getItem('userMemory');
    const savedModel = localStorage.getItem('selectedModel');
    const savedApiKey = localStorage.getItem('geminiApiKey');
    const savedGrounding = localStorage.getItem('isGroundingEnabled');

    if (savedGrounding) {
        setIsGroundingEnabled(JSON.parse(savedGrounding));
    }
    if (savedApiKey) {
      setApiKey(savedApiKey);
    }
    const allowedModels = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-image-preview'];
    if (savedModel && allowedModels.includes(savedModel)) {
      setModel(savedModel);
    }
    if (savedMemory) {
        setMemory(JSON.parse(savedMemory));
    }
    if (savedChats) {
      const parsedChats: ChatSession[] = JSON.parse(savedChats);
      // Remove file objects from persisted chats on load, as they are not serializable.
      parsedChats.forEach(chat => {
          chat.messages.forEach(msg => {
              if (msg.file) delete msg.file;
          });
      });

      const existingEmptyChat = parsedChats.find(c => c.messages.length === 0);

      if (existingEmptyChat) {
          setChats(parsedChats);
          setActiveChatId(existingEmptyChat.id);
      } else {
          const newChat: ChatSession = { id: Date.now().toString(), title: 'New Chat', messages: [] };
          setChats([newChat, ...parsedChats]);
          setActiveChatId(newChat.id);
      }
    } else {
      handleNewChat();
    }

    // Initialize Speech Recognition
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
  setIsSpeechSupported(true);
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = 'id-ID'; // Bahasa Indonesia

      recognition.onresult = (event: any) => {
        const transcript = event.results[event.results.length - 1][0].transcript.trim();
        setUserInput(prev => (prev ? prev + ' ' : '') + transcript);
        setVoiceError(null);
        if (textareaRef.current) {
          setTimeout(() => {
            const target = textareaRef.current!;
            target.style.height = 'auto';
            target.style.height = `${target.scrollHeight}px`;
          }, 0);
        }
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error, event.message);
        let errorMessage = 'An unknown error occurred with speech recognition.';
        switch (event.error) {
            case 'network':
                errorMessage = 'Network error. Please check your internet connection.';
                break;
            case 'not-allowed':
            case 'service-not-allowed':
                errorMessage = 'Microphone access denied. Please allow it in your browser settings.';
                break;
            case 'no-speech':
                errorMessage = 'No speech detected. Please try again.';
                break;
            case 'audio-capture':
                errorMessage = 'Could not capture audio. Is your microphone working?';
                break;
            default:
                errorMessage = `An error occurred: ${event.error}.`;
                break;
        }
        setVoiceError(errorMessage);
        setIsListening(false);
      };
      
      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    } else {
      console.warn("Speech recognition not supported by this browser.");
      setIsSpeechSupported(false);
    }

  }, []);

  useEffect(() => {
    if (chats.length > 0 && activeChatId) {
      // Create a serializable version of chats without File objects.
      const chatsToSave = JSON.parse(JSON.stringify(chats));
      chatsToSave.forEach((chat: ChatSession) => {
        chat.messages.forEach((msg: Message) => {
          if (msg.file) delete msg.file;
        });
      });
      localStorage.setItem('chatHistory', JSON.stringify(chatsToSave));
      localStorage.setItem('activeChatId', activeChatId);
    }
    localStorage.setItem('userMemory', JSON.stringify(memory));
    localStorage.setItem('selectedModel', model);
    localStorage.setItem('geminiApiKey', apiKey);
    localStorage.setItem('isGroundingEnabled', JSON.stringify(isGroundingEnabled));
  }, [chats, activeChatId, memory, model, apiKey, isGroundingEnabled]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prevTheme => (prevTheme === 'light' ? 'dark' : 'light'));
  };

  const handleNewChat = () => {
    // Find if an empty chat session already exists.
    const existingEmptyChat = chats.find(c => c.messages.length === 0);

    // If an empty chat exists...
    if (existingEmptyChat) {
      // ...and we are already on it, do nothing.
      if (activeChatId === existingEmptyChat.id) {
        return;
      }
      // ...otherwise, switch to it.
      setActiveChatId(existingEmptyChat.id);
      return;
    }

    // If no empty chat exists, create a new one.
    const newChat: ChatSession = { id: Date.now().toString(), title: 'New Chat', messages: [] };
    setChats(prev => [newChat, ...prev]);
    setActiveChatId(newChat.id);
  };

  const handleSelectChat = (id: string) => setActiveChatId(id);
  
  const requestDeleteChat = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setChatToDelete(id);
  };

  const handleDeleteChat = () => {
    if (!chatToDelete) return;
    
    const remainingChats = chats.filter(c => c.id !== chatToDelete);

    if (remainingChats.length === 0) {
        const newChat: ChatSession = { id: Date.now().toString(), title: 'New Chat', messages: [] };
        setChats([newChat]);
        setActiveChatId(newChat.id);
    } else {
        if (activeChatId === chatToDelete) {
            const newChat: ChatSession = { id: Date.now().toString(), title: 'New Chat', messages: [] };
            setChats([newChat, ...remainingChats]);
            setActiveChatId(newChat.id);
        } else {
            setChats(remainingChats);
        }
    }
    
    setChatToDelete(null);
  };

  const handleStartEditing = (chatId: string, currentTitle: string) => {
    setEditingChatId(chatId);
    setTempTitle(currentTitle);
  };
  
  const handleCancelEditing = () => {
    setEditingChatId(null);
    setTempTitle('');
  };
  
  const handleSaveTitle = (chatId: string) => {
    const trimmedTitle = tempTitle.trim();
    if (trimmedTitle) {
        setChats(prev => prev.map(c => (c.id === chatId ? { ...c, title: trimmedTitle } : c)));
    }
    handleCancelEditing();
  };

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [activeChat?.messages, isLoading]);
  
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isLoading) {
      interval = setInterval(() => setTimer(prev => prev + 100), 100);
    } else {
      setTimer(0);
    }
    return () => clearInterval(interval);
  }, [isLoading]);

  const generateTitle = async (userInput: string, chatId: string) => {
    try {
      const finalApiKey = apiKey || process.env.API_KEY as string;
      if (!finalApiKey) {
        throw new Error("API key is not set.");
      }
      const ai = new GoogleGenAI({ apiKey: finalApiKey });
      const prompt = `Generate a very short, concise title (4 words max) for a conversation starting with this message: "${userInput}". Do not include quotes or any preamble in your response.`;
      const result = await ai.models.generateContent({ model: 'gemini-1.5-flash', contents: prompt });
      const title = result.text.trim().replace(/"/g, ''); // Remove quotes
      setChats(prev => prev.map(c => c.id === chatId ? { ...c, title } : c));
    } catch (error) {
      console.error("Error generating title:", error);
    }
  };

  const fileToGenerativePart = (file: File): Promise<Part> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64Data = (reader.result as string).split(',')[1];
        resolve({ inlineData: { mimeType: file.type, data: base64Data } });
      };
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    });
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setAttachment(file);
    }
  };

  const handleRemoveAttachment = () => {
    setAttachment(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  
  // Fix: Helper to build API history by converting File objects to Parts on the fly.
  const buildApiHistory = (messages: Message[]): Promise<Content[]> => {
    return Promise.all(messages.map(async (msg) => {
        const content: Content = { role: msg.role, parts: [...msg.parts] };
        if (msg.role === 'user' && msg.file) {
            try {
                const filePart = await fileToGenerativePart(msg.file);
                // The text part is already in msg.parts, so we add the file part.
                content.parts.unshift(filePart);
            } catch (e) {
                console.error("Error processing file from history:", e);
            }
        }
        return content;
    }));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeChatId) return;

    const trimmedInput = userInput.trim();
    if (!trimmedInput && !attachment) return;
    
    setVoiceError(null);

    // Fix: This userMessage object is lightweight and stored in state. No base64 conversion yet.
    const userMessage: Message = {
      role: 'user',
      parts: trimmedInput ? [{ text: trimmedInput }] : [],
      file: attachment,
      attachmentName: attachment?.name,
    };
    const isFirstMessage = activeChat?.messages.length === 0;

    setUserInput('');
    setAttachment(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
    }

    setChats(prev => prev.map(c => c.id === activeChatId ? { ...c, messages: [...c.messages, userMessage] } : c));
    setIsLoading(true);

    if (isFirstMessage) {
      const titleText = trimmedInput || `Chat with ${attachment?.name || 'attachment'}`;
      generateTitle(titleText, activeChatId);
    }

    try {
      const finalApiKey = apiKey || process.env.API_KEY as string;
      if (!finalApiKey) {
        throw new Error("API key is not set. Please add it in Settings.");
      }
      const ai = new GoogleGenAI({ apiKey: finalApiKey });

      // Fix: Convert the file to base64 ONLY for the current API call.
      const userPartsForApi: Part[] = [];
      if (attachment) {
        try {
          userPartsForApi.push(await fileToGenerativePart(attachment));
        } catch (error) {
          console.error("Error processing file:", error);
          const errorMessage: Message = { role: 'model', parts: [{ text: 'Sorry, failed to process the attached file.' }] };
          setChats(prev => prev.map(c => c.id === activeChatId ? { ...c, messages: [...c.messages, errorMessage] } : c));
          setIsLoading(false);
          return;
        }
      }
      if (trimmedInput) {
        userPartsForApi.push({ text: trimmedInput });
      }

      if (model === 'gemini-2.5-flash-image-preview') {
          setLoadingStatus('Nano banana');
          const conversationHistory = await buildApiHistory(activeChat?.messages ?? []);
          const currentUserTurn: Content = { role: 'user', parts: userPartsForApi };
          
          // This model can handle both text and image prompts directly.
          const response = await ai.models.generateContent({
              model,
              contents: [...conversationHistory, currentUserTurn],
              // Configuration for image editing is kept, but it works for text too.
              config: {
                  responseModalities: [Modality.IMAGE, Modality.TEXT]
              }
          });
          const parts = response.candidates?.[0]?.content?.parts ?? [{text: "Could not get a response."}];
          const finalMessage: Message = { role: 'model', parts };
          setChats(prev => prev.map(c => c.id === activeChatId ? { ...c, messages: [...c.messages, finalMessage] } : c));
      } else {
        const mainChatHistory: Content[] = await buildApiHistory(activeChat?.messages ?? []);
        const currentUserTurn: Content = { role: 'user', parts: userPartsForApi };
        const conversationForAgents = [...mainChatHistory, currentUserTurn];
        
        const memoryContext = memory.length > 0
          ? `--- Start User Memory ---\nThe user has provided the following information about themselves. Use this to personalize your response:\n- ${memory.join('\n- ')}
--- End User Memory ---

`
          : '';

        let newMemory: string | null = null;
        
        const memoryPromise = (async () => {
          if (!userInput.trim()) return;
          try {
            const memoryHistory: Content[] = [...mainChatHistory, { role: 'user', parts: [{ text: userInput }] }];
            const response = await ai.models.generateContent({ model: 'gemini-1.5-flash', contents: memoryHistory, config: { systemInstruction: MEMORY_AGENT_SYSTEM_INSTRUCTION } });
            const memoryText = response.text.trim();
            if (memoryText && memoryText !== 'NO_UPDATE') newMemory = memoryText;
          } catch (e) { console.error("Memory agent failed", e); }
        })();
        
        const multiAgentPromise = (async () => {
            const agentConfig: any = {};
            if (isGroundingEnabled) {
              agentConfig.tools = [{ googleSearch: {} }];
            }

            setLoadingStatus('Initializing agents...');
            const initialAgentPromises = Array(4).fill(0).map(() => 
              ai.models.generateContent({ model, contents: conversationForAgents, config: { ...agentConfig, systemInstruction: memoryContext + INITIAL_SYSTEM_INSTRUCTION } })
            );
            const initialResponses = await Promise.all(initialAgentPromises);
            const initialAnswers = initialResponses.map(res => res.text);

            const textForContext = userPartsForApi.map(p => 'text' in p ? p.text : `[Attachment: ${attachment?.name || 'file'}]`).join('\n');

            await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay

            setLoadingStatus('Refining answers...');
            const refinementAgentPromises = initialAnswers.map((initialAnswer, index) => {
              const otherAnswers = initialAnswers.filter((_, i) => i !== index);
              const refinementContext = `My initial response was: "${initialAnswer}". The other agents responded with: 1. "${otherAnswers[0]}" 2. "${otherAnswers[1]}" 3. "${otherAnswers[2]}". Based on this context, critically re-evaluate and provide a new, improved response to the original query.`;
              const refinementTurn: Content = { role: 'user', parts: [{ text: `${textForContext}\n\n---INTERNAL CONTEXT---\n${refinementContext}` }] };
              return ai.models.generateContent({ model, contents: [...mainChatHistory, refinementTurn], config: { ...agentConfig, systemInstruction: memoryContext + REFINEMENT_SYSTEM_INSTRUCTION } });
            });
            const refinedResponses = await Promise.all(refinementAgentPromises);
            const refinedAnswers = refinedResponses.map(res => res.text);

            await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay

            setLoadingStatus('Synthesizing final response...');
            const synthesizerContext = `Here are the four refined responses to the user's query. Your task is to synthesize them into the best single, final answer.\n\nRefined Response 1:\n"${refinedAnswers[0]}"\n\nRefined Response 2:\n"${refinedAnswers[1]}"\n\nRefined Response 3:\n"${refinedAnswers[2]}"\n\nRefined Response 4:\n"${refinedAnswers[3]}"`;
            const synthesizerTurn: Content = { role: 'user', parts: [{ text: `${textForContext}\n\n---INTERNAL CONTEXT---\n${synthesizerContext}` }] };

            const finalResult = await ai.models.generateContent({ model, contents: [...mainChatHistory, synthesizerTurn], config: { ...agentConfig, systemInstruction: memoryContext + SYNTHESIZER_SYSTEM_INSTRUCTION } });
            return finalResult;
        })();
        
        const [_, finalResult] = await Promise.all([memoryPromise, multiAgentPromise]);
        
        if (newMemory && !memory.includes(newMemory)) {
          setMemory(prev => [...prev, newMemory!]);
        }
        
        const groundingChunks = finalResult.candidates?.[0]?.groundingMetadata?.groundingChunks;
        const finalMessage: Message = { role: 'model', parts: [{ text: finalResult.text }], memoryUpdated: !!newMemory, groundingChunks };
        setChats(prev => prev.map(c => c.id === activeChatId ? { ...c, messages: [...c.messages, finalMessage] } : c));
      }

    } catch (error) {
      console.error('Error sending message to agents:', error);
      let errorMessageText = 'Sorry, I encountered an error. Please try again.';
      if (error instanceof Error) {
        if (error.message.includes("RESOURCE_EXHAUSTED")) {
            errorMessageText = "Anda telah melebihi kuota API Anda saat ini. Silakan periksa paket dan detail tagihan Anda, atau coba lagi nanti.";
        } else if (error.message.includes("API key not valid")) {
            errorMessageText = "API key tidak valid. Silakan periksa kembali API key Anda di pengaturan.";
        }
        else {
            errorMessageText = `Terjadi kesalahan: ${error.message}`;
        }
      }
      const errorMessage: Message = { role: 'model', parts: [{ text: errorMessageText }] };
      setChats(prev => prev.map(c => c.id === activeChatId ? { ...c, messages: [...c.messages, errorMessage] } : c));
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleVoiceInputToggle = () => {
    if (!recognitionRef.current) return;
    
    setVoiceError(null); // Clear previous errors

    if (isListening) {
      recognitionRef.current.stop();
      // onend will set isListening to false
    } else {
      if (!navigator.onLine) {
        setVoiceError("You seem to be offline. Voice input requires an internet connection.");
        return;
      }
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch (e) {
        console.error("Could not start recognition:", e);
        setVoiceError("Could not start voice recognition. Please try again.");
        setIsListening(false);
      }
    }
  };

  // The filtered chats are now only used for the search modal
  const filteredChats = chats.filter(chat => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return true; // Show all chats if query is empty

    const titleMatch = chat.title.toLowerCase().includes(query);
    if (titleMatch) return true;

    const contentMatch = chat.messages.some(message =>
        message.parts.some(part =>
            'text' in part && part.text && part.text.toLowerCase().includes(query)
        )
    );
    return contentMatch;
  });
  
  // The sidebar will now always show all chats
  const sortedChats = [...chats].sort((a, b) => parseInt(b.id, 10) - parseInt(a.id, 10));
  const messages = activeChat?.messages ?? [];

  return (
    <div className={`app-layout ${isSidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <div className="sidebar-backdrop" onClick={() => setIsSidebarOpen(false)}></div>
      <Sidebar
        chats={sortedChats}
        activeChatId={activeChatId}
        onNewChat={handleNewChat}
        onSelectChat={handleSelectChat}
        onDeleteChat={requestDeleteChat}
        editingChatId={editingChatId}
        tempTitle={tempTitle}
        onTempTitleChange={setTempTitle}
        onStartEditing={handleStartEditing}
        onSaveTitle={handleSaveTitle}
        onCancelEditing={handleCancelEditing}
        onOpenSearch={() => setIsSearchModalOpen(true)}
      />
       <main className="chat-container">
        {isDragging && !isLoading && <DragDropOverlay />}
        <header>
          <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="icon-button sidebar-toggle" aria-label="Toggle sidebar">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            </svg>
          </button>
          <h1>{activeChat?.title || 'Multi-Agent Chat'}</h1>
          <div className="header-actions">
            <div className="model-selector-container">
                <label htmlFor="model-selector">Model:</label>
                <select id="model-selector" className="model-selector" value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="gemini-2.5-pro">Pro</option>
                    <option value="gemini-2.5-flash">Flash</option>
                    <option value="gemini-2.5-flash-lite">Flash lite</option>
                    <option value="gemini-2.5-flash-image-preview">Nano Banana</option>
                </select>
            </div>
             <button onClick={() => setIsMemoryModalOpen(true)} className="icon-button" aria-label="Memory & Settings" title="Memory & Settings">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.438.995s.145.755.438.995l1.003.827c.48.398.668 1.05.26 1.431l-1.296 2.247a1.125 1.125 0 0 1-1.37.49l-1.217-.456c-.355-.133-.75-.072-1.075.124a6.57 6.57 0 0 1-.22.127c-.332.183-.582.495-.645.87l-.213 1.281c-.09.543-.56.94-1.11.94h-2.593c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.063-.374-.313-.686-.645-.87a6.52 6.52 0 0 1-.22-.127c-.324-.196-.72-.257-1.075-.124l-1.217.456a1.125 1.125 0 0 1-1.37-.49l-1.296-2.247a1.125 1.125 0 0 1 .26-1.431l1.003-.827c.293-.24.438-.613.438-.995s-.145-.755-.438-.995l-1.003-.827a1.125 1.125 0 0 1-.26-1.431l1.296-2.247a1.125 1.125 0 0 1 1.37-.49l1.217.456c.355.133.75.072 1.075-.124.073-.044.146-.087.22-.127.332-.183.582-.495.645-.87l.213-1.281Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
             </button>
            <ThemeToggle theme={theme} toggleTheme={toggleTheme} />
          </div>
        </header>
        <div className="message-list" ref={messageListRef}>
          {messages.length === 0 ? (
            <div className="welcome-container">
                <WelcomeMessage />
                {!apiKey && <ApiKeyPrompt onSettingsClick={() => setIsMemoryModalOpen(true)} />}
            </div>
          ) : (
            <>
              {messages.map((msg, index) => (
                <div key={index} className={`message-wrapper ${msg.role}`}>
                  <div className={`message ${msg.role}`}>
                    {msg.role === 'model' && <span className="agent-label">Synthesizer Agent</span>}
                    <MessageContent parts={msg.parts} file={msg.file} attachmentName={msg.attachmentName} />
                  </div>
                  {msg.groundingChunks && msg.groundingChunks.length > 0 && (
                    <GroundingCitations chunks={msg.groundingChunks} />
                  )}
                  {msg.role === 'model' && msg.memoryUpdated && (
                    <div className="memory-update-indicator">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 6.75h7.5M8.25 12h7.5m-7.5 5.25h7.5M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75V17.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                      </svg>
                      <span>Memory Updated</span>
                    </div>
                  )}
                </div>
              ))}
              {isLoading && <LoadingIndicator status={loadingStatus} time={timer} />}
            </>
          )}
        </div>
        <form className="input-area" onSubmit={handleSubmit}>
          {attachment && <AttachmentPreview file={attachment} onRemove={handleRemoveAttachment} />}
          <div className="input-controls">
            <textarea
                ref={textareaRef}
                name="userInput"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                placeholder={!apiKey ? "Please enter your API key in settings" : isListening ? "Listening..." : "Ask anything..."}
                aria-label="User input"
                disabled={isLoading || !apiKey}
                rows={1}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                    }
                }}
                onInput={(e) => {
                    const target = e.currentTarget;
                    target.style.height = 'auto';
                    target.style.height = `${target.scrollHeight}px`;
                }}
            />
            <div className="input-actions-bar">
              <div className="input-actions-left">
                  <button
                      type="button"
                      className={`grounding-button ${isGroundingEnabled ? 'active' : ''}`}
                      onClick={() => !isNanoBananaModel && setIsGroundingEnabled(!isGroundingEnabled)}
                      disabled={isNanoBananaModel}
                      aria-pressed={!isNanoBananaModel && isGroundingEnabled}
                      title={isNanoBananaModel ? "This model doesn't support search" : (isGroundingEnabled ? 'Disable Google Search Grounding' : 'Enable Google Search Grounding')}
                  >
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
                      </svg>
                      <span>Search</span>
                  </button>
              </div>
              <div className="input-actions-right">
                  <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} accept="image/*,video/*,audio/*,application/pdf,text/*,.md" />
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="icon-button attachment-button" aria-label="Attach file" title="Attach file" disabled={isLoading}>
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
                  </button>
                  <button 
                    type="button" 
                    onClick={handleVoiceInputToggle}
                    className={`icon-button voice-button ${isListening ? 'listening' : ''}`}
                    aria-label={isListening ? 'Stop listening' : 'Start voice input'}
                    title={isSpeechSupported ? (isListening ? 'Stop listening' : 'Start voice input') : 'Voice input not supported by your browser'}
                    disabled={isLoading || !isSpeechSupported}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"/>
                    </svg>
                  </button>
                  <button type="submit" className="submit-button" disabled={isLoading || (!attachment && !userInput.trim()) || !apiKey} aria-label="Send message">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/>
                    </svg>
                  </button>
              </div>
            </div>
          </div>
          {voiceError && <div className="voice-error-message">{voiceError}</div>}
        </form>
      </main>
      <SearchModal
        isOpen={isSearchModalOpen}
        onClose={() => {
            setIsSearchModalOpen(false);
            setSearchQuery('');
        }}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        results={filteredChats}
        onSelectChat={handleSelectChat}
       />
      <ConfirmationModal
        isOpen={!!chatToDelete}
        onClose={() => setChatToDelete(null)}
        onConfirm={handleDeleteChat}
        title="Delete Chat"
     >
        Are you sure you want to permanently delete this chat? This action cannot be undone.
     </ConfirmationModal>
      <MemoryModal
        isOpen={isMemoryModalOpen}
        onClose={() => setIsMemoryModalOpen(false)}
        memory={memory}
        apiKey={apiKey}
        onSave={(newMemory, newApiKey) => {
            setMemory(newMemory);
            setApiKey(newApiKey);
            setIsMemoryModalOpen(false);
        }}
     />
     <WelcomeModal 
        isOpen={isWelcomeModalOpen}
        onClose={() => setIsWelcomeModalOpen(false)}
     />
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);