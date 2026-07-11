import React, { Component, ErrorInfo, ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { Toaster } from 'sonner'

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px 20px', fontFamily: 'monospace', color: '#EF4444', background: '#FEF2F2', minHeight: '100vh', boxSizing: 'border-box' }}>
          <h2 style={{ margin: '0 0 16px 0', fontSize: '20px', fontWeight: 'bold' }}>⚠️ Application Critical Render Error</h2>
          <div style={{ background: 'white', border: '1px solid #FCA5A5', borderRadius: '8px', padding: '16px', fontSize: '14px', whiteSpace: 'pre-wrap', marginBottom: '20px', overflowX: 'auto', color: '#1F2937' }}>
            {this.state.error?.toString()}
          </div>
          {this.state.error?.stack && (
            <details style={{ cursor: 'pointer' }} open>
              <summary style={{ fontSize: '14px', fontWeight: 'bold', color: '#4B5563', marginBottom: '8px' }}>Error Stack Trace</summary>
              <pre style={{ background: '#F3F4F6', color: '#374151', padding: '12px', borderRadius: '8px', overflowX: 'auto', fontSize: '11px', lineHeight: 1.5 }}>
                {this.state.error.stack}
              </pre>
            </details>
          )}
          <button 
            onClick={() => { localStorage.clear(); window.location.reload(); }}
            style={{ marginTop: '24px', background: '#EF4444', color: 'white', border: 'none', padding: '10px 18px', borderRadius: '6px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer' }}
          >
            Clear Application State & Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <Toaster position="top-right" richColors />
  </React.StrictMode>
)

