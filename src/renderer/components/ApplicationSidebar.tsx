import * as Tooltip from '@radix-ui/react-tooltip'
import type { RendererRoute } from '../../shared/navigation'
import { ChronaMark, Icon, type IconName } from './Icon'

type PrimaryTarget = 'today' | 'timeline' | 'reflect' | 'insights' | 'ask'

const primaryItems: Array<{ target: PrimaryTarget; label: string; icon: IconName }> = [
  { target: 'today', label: 'Today', icon: 'sun' },
  { target: 'timeline', label: 'Timeline', icon: 'timeline' },
  { target: 'reflect', label: 'Reflect', icon: 'book' },
  { target: 'insights', label: 'Insights', icon: 'chart' },
  { target: 'ask', label: 'Ask', icon: 'spark' }
]

export function ApplicationSidebar(props: {
  route: RendererRoute
  recording: boolean
  systemPaused: boolean
  platform: 'darwin' | 'win32' | 'linux'
  onNavigate: (target: PrimaryTarget | 'settings' | 'onboarding') => void
  onToggleRecording: () => Promise<void>
}) {
  return (
    <Tooltip.Provider delayDuration={350}>
      <aside className="appSidebar" aria-label="Primary navigation">
        <div className="sidebarBrand" aria-label="Chrona">
          <span className="brandMark" aria-hidden="true"><ChronaMark /></span>
          <span className="sidebarWordmark">Chrona</span>
        </div>
        <nav className="primaryNav">
          {primaryItems.map((item) => (
            <NavButton key={item.target} label={item.label} active={props.route.name === item.target} onClick={() => props.onNavigate(item.target)} icon={item.icon} />
          ))}
        </nav>
        <div className="sidebarBottom">
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button className={`captureStatus ${props.recording ? 'recording' : ''}`} onClick={() => void props.onToggleRecording()} aria-pressed={props.recording} aria-label={props.recording ? 'Stop recording' : 'Start recording'}>
                <span className="captureStatusDot" aria-hidden="true" />
                <span className="captureStatusCopy"><strong>{props.systemPaused ? 'System paused' : props.recording ? 'Recording' : 'Not recording'}</strong><small>{props.recording ? 'Click to stop' : 'Click to start'}</small></span>
              </button>
            </Tooltip.Trigger>
            <Tooltip.Content side="right" className="tooltip">{props.recording ? 'Stop recording' : 'Start recording'}</Tooltip.Content>
          </Tooltip.Root>
          <NavButton label="Settings" active={props.route.name === 'settings'} onClick={() => props.onNavigate('settings')} icon="settings" shortcut={props.platform === 'darwin' ? '⌘,' : 'Ctrl+,'} />
          <NavButton label="Help & setup" active={props.route.name === 'onboarding'} onClick={() => props.onNavigate('onboarding')} icon="help" />
        </div>
      </aside>
    </Tooltip.Provider>
  )
}

function NavButton(props: { label: string; active: boolean; onClick: () => void; icon: IconName; shortcut?: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className={`navItem ${props.active ? 'active' : ''}`} onClick={props.onClick} aria-current={props.active ? 'page' : undefined} aria-label={props.label}>
          <Icon name={props.icon} /><span>{props.label}</span>{props.shortcut ? <kbd>{props.shortcut}</kbd> : null}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content side="right" className="tooltip">{props.label}</Tooltip.Content>
    </Tooltip.Root>
  )
}
