//! Parameter types shared by analysis, the reference implementation and the shader.

/// Automatic correction: an affine colour transform in linear light.
///
/// `m[row]` is `[from_r, from_g, from_b, offset]` for the output channel `row`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Correction {
    pub m: [[f32; 4]; 3],
}

impl Correction {
    pub const IDENTITY: Correction =
        Correction { m: [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]] };

    /// Blend between identity (`t = 0`) and this correction (`t = 1`).
    pub fn scaled(&self, t: f32) -> Correction {
        let mut out = Correction::IDENTITY;
        for r in 0..3 {
            for c in 0..4 {
                let id = Correction::IDENTITY.m[r][c];
                out.m[r][c] = id + (self.m[r][c] - id) * t;
            }
        }
        out
    }

    /// Row-major, 12 values.
    pub fn to_array(&self) -> [f32; 12] {
        let mut a = [0.0; 12];
        for r in 0..3 {
            a[r * 4..r * 4 + 4].copy_from_slice(&self.m[r]);
        }
        a
    }

    pub fn from_array(a: &[f32]) -> Correction {
        let mut c = Correction::IDENTITY;
        for r in 0..3 {
            c.m[r].copy_from_slice(&a[r * 4..r * 4 + 4]);
        }
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
}

impl Default for Adjustments {
    fn default() -> Self {
        Adjustments { strength: 1.0, temperature: 0.0, tint: 0.0, exposure: 0.0, contrast: 0.0, saturation: 0.0 }
    }
}

impl Adjustments {
    /// Order: strength, temperature, tint, exposure, contrast, saturation.
    pub fn from_array(a: &[f32]) -> Adjustments {
        Adjustments { strength: a[0], temperature: a[1], tint: a[2], exposure: a[3], contrast: a[4], saturation: a[5] }
    }
}
