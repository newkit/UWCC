//! Parameter types shared by analysis, the reference implementation and the shader.

/// The selectable correction methods. The numeric ids cross the WASM boundary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algorithm {
    /// UWCC's own method (`analysis`).
    Uwcc = 0,
    /// Hue-shifted red plus per-channel levels (`matrix`).
    Matrix = 1,
    /// Red compensation and grey-world balance after Ancuti et al. 2018 (`ancuti`).
    Ancuti = 2,
    /// The Sea-thru image formation model on an estimated range map (`seathru`).
    SeaThru = 3,
    /// UWCC's own method without its cast check: always applied in full.
    UwccAlways = 4,
}

impl Algorithm {
    pub const ALL: [Algorithm; 5] =
        [Algorithm::Uwcc, Algorithm::Matrix, Algorithm::Ancuti, Algorithm::SeaThru, Algorithm::UwccAlways];

    pub fn from_id(id: u32) -> Option<Algorithm> {
        Algorithm::ALL.into_iter().find(|a| *a as u32 == id)
    }
}

/// Number of samples in each range table of a [`Correction`]: evenly spaced
/// over range-map values 0 (near) to 1 (far).
pub const RANGE_NODES: usize = 8;

/// Number of values in the flat form of a [`Correction`].
pub const CORRECTION_LEN: usize = 16 + 6 * RANGE_NODES;

/// Automatic correction: the parameters of the per-pixel pipeline in
/// `reference`. Every method fills in the part it needs and leaves the rest
/// neutral, so one shader serves all of them.
///
/// The steps, in order:
///
/// 1. take the pixel sRGB-encoded (`encoded`) or in linear light;
/// 2. channel compensation: `r += comp[0] * (1 - r) * g`, `b += comp[1] * (1 - b) * g`;
/// 3. if `ranged`: remove backscatter and undo attenuation as functions of the pixel's range;
/// 4. the affine transform `m`, clamped at zero.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Correction {
    /// `m[row]` is `[from_r, from_g, from_b, offset]` for the output channel `row`.
    pub m: [[f32; 4]; 3],
    /// Steps 2 to 4 run on sRGB-encoded values instead of linear light.
    pub encoded: bool,
    /// Compensation of red and of blue from green.
    pub comp: [f32; 2],
    /// Per channel: backscatter to subtract, tabulated over range.
    ///
    /// The range-dependent curves are stored as tables, not as the parameters
    /// of the functions they were fitted with: tables of two corrections can
    /// be blended value by value (video interpolates between analysed
    /// frames), whereas blended function parameters describe a curve that has
    /// nothing to do with either.
    pub backscatter: [[f32; RANGE_NODES]; 3],
    /// Per channel: natural logarithm of the gain that undoes attenuation, tabulated over range.
    pub log_gain: [[f32; RANGE_NODES]; 3],
    /// Step 3 is active; the pipeline needs a range map.
    pub ranged: bool,
}

impl Correction {
    pub const IDENTITY: Correction =
        Correction::affine([[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]]);

    /// A plain affine colour transform in linear light.
    pub const fn affine(m: [[f32; 4]; 3]) -> Correction {
        Correction {
            m,
            encoded: false,
            comp: [0.0; 2],
            backscatter: [[0.0; RANGE_NODES]; 3],
            log_gain: [[0.0; RANGE_NODES]; 3],
            ranged: false,
        }
    }

    /// Value of a range table at range-map value `d` (0..1): linear between the samples.
    pub fn lookup(table: &[f32; RANGE_NODES], d: f32) -> f32 {
        let t = d.clamp(0.0, 1.0) * (RANGE_NODES - 1) as f32;
        let i = (t.floor() as usize).min(RANGE_NODES - 2);
        table[i] + (table[i + 1] - table[i]) * (t - i as f32)
    }

    /// Blend the affine part between identity (`t = 0`) and this correction (`t = 1`).
    pub fn scaled(&self, t: f32) -> Correction {
        let mut out = *self;
        for r in 0..3 {
            for c in 0..4 {
                let id = Correction::IDENTITY.m[r][c];
                out.m[r][c] = id + (self.m[r][c] - id) * t;
            }
        }
        out
    }

    /// Flat form: matrix (12, row-major), encoded flag, compensation (2),
    /// backscatter (3 x `RANGE_NODES`), log gain (3 x `RANGE_NODES`), ranged flag.
    pub fn to_array(&self) -> [f32; CORRECTION_LEN] {
        let mut a = [0.0; CORRECTION_LEN];
        for r in 0..3 {
            a[r * 4..r * 4 + 4].copy_from_slice(&self.m[r]);
            let n = RANGE_NODES;
            a[15 + r * n..15 + (r + 1) * n].copy_from_slice(&self.backscatter[r]);
            a[15 + (3 + r) * n..15 + (4 + r) * n].copy_from_slice(&self.log_gain[r]);
        }
        a[12] = self.encoded as u8 as f32;
        a[13..15].copy_from_slice(&self.comp);
        a[CORRECTION_LEN - 1] = self.ranged as u8 as f32;
        a
    }

    /// Inverse of [`Correction::to_array`]; `a` must hold at least [`CORRECTION_LEN`] values.
    pub fn from_array(a: &[f32]) -> Correction {
        let mut c = Correction::IDENTITY;
        for r in 0..3 {
            c.m[r].copy_from_slice(&a[r * 4..r * 4 + 4]);
            let n = RANGE_NODES;
            c.backscatter[r].copy_from_slice(&a[15 + r * n..15 + (r + 1) * n]);
            c.log_gain[r].copy_from_slice(&a[15 + (3 + r) * n..15 + (4 + r) * n]);
        }
        c.encoded = a[12] > 0.5;
        c.comp.copy_from_slice(&a[13..15]);
        c.ranged = a[CORRECTION_LEN - 1] > 0.5;
        c
    }
}

/// Manual adjustments. All neutral at their defaults.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Adjustments {
    /// 0 = original image, 1 = full automatic correction.
    pub strength: f32,
    /// -1 (cooler) .. 1 (warmer).
    pub temperature: f32,
    /// -1 (greener) .. 1 (more magenta).
    pub tint: f32,
    /// Exposure in stops, -2 .. 2.
    pub exposure: f32,
    /// -1 .. 1.
    pub contrast: f32,
    /// -1 (greyscale) .. 1.
    pub saturation: f32,
    /// Channel gains from the neutral picker (`reference::neutral_gains`); 1 = none.
    pub neutral: [f32; 3],
}

/// Number of values in the flat form of [`Adjustments`].
pub const ADJUSTMENTS_LEN: usize = 9;

impl Default for Adjustments {
    fn default() -> Self {
        Adjustments {
            strength: 1.0,
            temperature: 0.0,
            tint: 0.0,
            exposure: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            neutral: [1.0; 3],
        }
    }
}

impl Adjustments {
    /// Order: strength, temperature, tint, exposure, contrast, saturation, neutral gains (3).
    /// `a` must hold [`ADJUSTMENTS_LEN`] values.
    pub fn from_array(a: &[f32]) -> Adjustments {
        Adjustments {
            strength: a[0],
            temperature: a[1],
            tint: a[2],
            exposure: a[3],
            contrast: a[4],
            saturation: a[5],
            neutral: [a[6], a[7], a[8]],
        }
    }
}
