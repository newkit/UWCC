import { type Adjustments, COLOR_MODES, CONTROLS, type ColorMode, DEFAULT_ADJUSTMENTS, colorModeOf, hasNeutral, withColorMode } from '../model';

type Props = {
  adjustments: Adjustments;
  onChange: (next: Adjustments) => void;
  disabled: boolean;
};

export function Controls({ adjustments, onChange, disabled }: Props) {
  const changed = hasNeutral(adjustments) || CONTROLS.some((c) => adjustments[c.key] !== DEFAULT_ADJUSTMENTS[c.key]);
  const mode = colorModeOf(adjustments);
  return (
    <div className="controls">
      <div className="control">
        <div className="control-head">
          <label htmlFor="control-mode">Colour mode</label>
        </div>
        <select
          id="control-mode"
          value={mode ?? 'custom'}
          disabled={disabled}
          onChange={(event) => onChange(withColorMode(adjustments, event.target.value as ColorMode))}
        >
          {COLOR_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          {mode === null && <option value="custom" disabled>Custom</option>}
        </select>
      </div>
      {CONTROLS.map((control) => {
        const value = adjustments[control.key];
        const isDefault = value === DEFAULT_ADJUSTMENTS[control.key];
        const id = `control-${control.key}`;
        return (
          <div className="control" key={control.key}>
            <div className="control-head">
              <label htmlFor={id}>{control.label}</label>
              <button
                type="button"
                className="value"
                disabled={disabled || isDefault}
                title="Reset"
                aria-label={`Reset ${control.label}`}
                onClick={() => onChange({ ...adjustments, [control.key]: DEFAULT_ADJUSTMENTS[control.key] })}
              >
                {control.format(value)}
              </button>
            </div>
            <input
              id={id}
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={value}
              disabled={disabled}
              onChange={(event) => onChange({ ...adjustments, [control.key]: Number(event.target.value) })}
              onDoubleClick={() => onChange({ ...adjustments, [control.key]: DEFAULT_ADJUSTMENTS[control.key] })}
            />
          </div>
        );
      })}
      <button type="button" className="ghost" disabled={disabled || !changed} onClick={() => onChange(DEFAULT_ADJUSTMENTS)}>
        Reset all
      </button>
    </div>
  );
}
