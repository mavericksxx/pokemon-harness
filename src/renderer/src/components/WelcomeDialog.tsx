import { useState } from 'react';
import { AGENT_PROVIDERS, type AgentProviderId } from '@shared/agentProvider';
import { useAppSettingsStore } from '@/store/appSettingsStore';

/** Providers offered here — same claude/codex-only scope as the
 *  SummonArceusDialog select (BACKLOG item 1's "ignore cursor-agent unless
 *  trivially free"): this picker is also what seeds `defaultAgentProvider`,
 *  and cursor-agent's spawn/summon path was never verified for either flow. */
const WELCOME_PROVIDERS: AgentProviderId[] = ['claude', 'codex'];

interface Props {
  /** Opens the real SummonArceusDialog — this component never spawns
   *  anything itself, same separation SummonArceusButton already keeps
   *  between "decide to summon" and "the summon dialog." */
  onSummonArceus(): void;
}

/**
 * First-launch welcome dialog (BACKLOG item 2) — shown once, gated on
 * `appSettings.onboardingDone` (App.tsx mounts this exactly while that's
 * false; main.tsx's boot() also reads it to skip the silent auto-summon
 * while it's showing). No backdrop-dismiss: unlike every other `.modal` in
 * this app, this one always needs the user to record a choice (which
 * provider) before it can stop showing, so an accidental outside click
 * would leave the setting in whatever the current select happens to be
 * without the user meaning to commit to it — both real actions below
 * (`summon`/`notNow`) commit explicitly instead.
 *
 * Picking a provider here writes STRAIGHT to `defaultAgentProvider` (the
 * same field NewSessionDialog and SummonArceusDialog already default from)
 * — there's no separate "welcome provider" setting to keep in sync with it.
 */
export function WelcomeDialog({ onSummonArceus }: Props): JSX.Element {
  const configuredProvider = useAppSettingsStore((s) => s.settings.defaultAgentProvider);
  const setDefaultAgentProvider = useAppSettingsStore((s) => s.setDefaultAgentProvider);
  const setOnboardingDone = useAppSettingsStore((s) => s.setOnboardingDone);
  const [provider, setProvider] = useState<AgentProviderId>(
    WELCOME_PROVIDERS.includes(configuredProvider) ? configuredProvider : 'claude'
  );

  // Setting `onboardingDone` true here is what unmounts this dialog — App.tsx
  // renders it off `!appSettings.onboardingDone` directly, no local "open"
  // state to also flip.
  const commit = (): void => {
    setDefaultAgentProvider(provider);
    setOnboardingDone(true);
  };

  const summon = (): void => {
    commit();
    onSummonArceus();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>welcome to pokéharness</h2>
        <p className="hint">
          a garden where each of your coding agents grows as a pokémon while it works — this app just gives them a
          terminal, a home, and someone watching over the whole garden.
        </p>

        <label>
          main provider
          <select value={provider} onChange={(e) => setProvider(e.target.value as AgentProviderId)}>
            {WELCOME_PROVIDERS.map((id) => (
              <option key={id} value={id}>
                {AGENT_PROVIDERS[id].label}
              </option>
            ))}
          </select>
          <p className="hint">the default for new agents and for arceus — change it anytime in settings.</p>
        </label>

        <div className="modal-actions">
          <button type="button" onClick={commit}>
            not now
          </button>
          <button type="button" className="primary" onClick={summon}>
            summon arceus
          </button>
        </div>
      </div>
    </div>
  );
}
