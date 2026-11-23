import { useEffect, useRef } from 'react';
import { fsAccess } from '../io/sources';
import { cleanSuffix, type Settings } from '../settings/settings';

type Props = { open: boolean; settings: Settings; onChange: (next: Settings) => void; onClose: () => void };

export function SettingsDialog({ open, settings, onChange, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current!;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const canWrite = fsAccess.files || fsAccess.folders;

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <form method="dialog" onSubmit={onClose}>
        <h2>Settings</h2>

        <fieldset>
          <legend>Where results are saved</legend>
          <label className="choice">
            <input type="radio" name="mode" checked={settings.outputMode === 'next'} onChange={() => onChange({ ...settings, outputMode: 'next' })} />
            <span>
              <strong>Next to the original</strong>
              <small>A new file beside the source, with the suffix below. The original is never changed.</small>
            </span>
          </label>
          <label className={'choice' + (canWrite ? '' : ' unavailable')}>
            <input type="radio" name="mode" disabled={!canWrite} checked={settings.outputMode === 'overwrite'} onChange={() => onChange({ ...settings, outputMode: 'overwrite' })} />
            <span>
              <strong>Replace the original</strong>
              <small>
                {canWrite
                  ? 'The corrected photo takes the place of the source file. The original is lost and cannot be restored by UWCC.'
                  : 'Not available: this browser does not let web pages write to your files.'}
              </small>
            </span>
          </label>
          {!canWrite && <p className="note">In this browser, results are saved to the download folder.</p>}
          {settings.outputMode === 'overwrite' && canWrite && (
            <p className="note warning">Originals that are not JPEG files are kept, and their result is saved as a new file.</p>
          )}
        </fieldset>

        <label className="field">
          <span>File name suffix</span>
          <input
            type="text"
            value={settings.suffix}
            maxLength={24}
            spellCheck={false}
            onChange={(e) => onChange({ ...settings, suffix: e.target.value })}
            onBlur={(e) => onChange({ ...settings, suffix: cleanSuffix(e.target.value) })}
          />
          <small>IMG_0042.jpg becomes IMG_0042{cleanSuffix(settings.suffix)}.jpg</small>
        </label>

        <label className="field">
          <span>JPEG quality: {settings.jpegQuality}</span>
          <input type="range" min={60} max={100} step={1} value={settings.jpegQuality} onChange={(e) => onChange({ ...settings, jpegQuality: Number(e.target.value) })} />
        </label>

        <label className="choice">
          <input type="checkbox" checked={settings.skipProcessed} onChange={(e) => onChange({ ...settings, skipProcessed: e.target.checked })} />
          <span>
            <strong>Skip files already corrected</strong>
            <small>Photos UWCC has saved before are left out, so nothing is corrected twice. Applies to files added from now on.</small>
          </span>
        </label>

        <div className="dialog-actions">
          <button type="submit" className="primary">Done</button>
        </div>
      </form>
    </dialog>
  );
}
