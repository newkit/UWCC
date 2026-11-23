import { type Adjustments, CONTROLS, DEFAULT_ADJUSTMENTS } from '../model';

type Props = {
  adjustments: Adjustments;
  onChange: (next: Adjustments) => void;
  disabled: boolean;
};

export function Controls({ adjustments, onChange, disabled }: Props) {
  const changed = CONTROLS.some((c) => adjustments[c.key] !== DEFAULT_ADJUSTMENTS[c.key]);
  return (
    <div className="controls">
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
