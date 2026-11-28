# PStudio Visual Identity Specification

**Phase:** 1 — Visual Identity  
**Status:** Design specification; no rendering defaults, shaders, assets or scene output are changed by this document.  
**Governing art direction:** **Reality 55 : Anime 45**

## 1. Purpose

PStudio must develop a recognizable visual identity rather than reproduce a generic photoreal renderer or a generic anime renderer. The target is physically convincing light, materials, atmosphere and water, shaped by deliberate color, contrast and composition so the result retains the visual appeal of high-quality animated environment art.

The 55:45 ratio is an art-direction principle for the image as a whole. It is **not** a literal 0.55/0.45 shader blend, a percentage of pixels, or a numerical parameter applied uniformly to every material. Physical plausibility is the rendering foundation; artistic treatment is the controlled presentation layer.

## 2. Non-negotiable principles

1. **Physical coherence first.** Direct light, indirect light, material response, atmosphere and reflections must agree with one another. A visually attractive compensation must not create obvious contradictions elsewhere in the scene.
2. **Art direction is intentional.** Color relationships, tonal separation, selective saturation, softness and composition may be artistically shaped. They should enhance form and mood rather than erase physical cues.
3. **The whole scene must agree.** Sky, sun elevation, HDR environment, shadow color, water reflection, fog and material response must describe the same time and environment state.
4. **Detail must survive motion.** Reflection, shadows, foliage and fine surface detail must remain temporally stable during camera movement and lighting transitions.
5. **Quality is not sacrificed silently.** Performance changes must be measured and compared against image and temporal baselines. No blanket resolution reduction, effect removal or hidden quality downgrade is accepted as the default solution.
6. **Preserve established assets and scenes.** The Nov 24 day/dusk/night sky panorama remains a protected baseline during this phase. Existing shrine composition and signature water reflection must not be replaced by approximations.

## 3. The 55:45 visual balance

### Reality — 55

The reality side supplies the image's credibility:

- Physically based material response and energy-consistent lighting.
- Direct illumination with natural shadowing and penumbra.
- Spatial indirect illumination and plausible bounce-light gradients.
- Environment lighting consistent with solar elevation and sky state.
- Atmospheric attenuation, scattering and depth cues.
- Water reflection, refraction and depth-dependent absorption.
- Material-specific roughness, metalness and normal detail.

### Anime — 45

The anime side supplies visual identity and emotional readability:

- Deliberate hue relationships and controlled color separation.
- Clear, composed luminance hierarchy without crushing shadow detail.
- Selective saturation and warm/cool balance tied to the scene's mood.
- Graceful highlight roll-off and restrained glow around genuinely bright sources.
- Deliberately composed silhouettes, readable forms and selective detail emphasis.
- A coherent finish across architecture, vegetation, water and sky.

The artistic layer may stylize the final result, but must not make wet stone behave like polished metal, make the sky disagree with the sun, or make reflections contradict the scene geometry.

## 4. Rendering requirements by system

### 4.1 Lighting, shadows and indirect illumination

**Target:** soft, continuous natural shading rather than flat fill or harsh binary shadows.

- Physically based PBR response for dielectric and metallic surfaces.
- Direct light and environment lighting are kept distinct in the shading model.
- Multi-scale soft-shadow filtering, with contact detail retained near occluders.
- Spatial spherical-harmonic (SH) indirect illumination for low-frequency incoming light.
- Multi-bounce appearance may use a controlled SH/probe approximation; the result must be identified as an approximation, not path-traced transport.
- Bounce light and ambient contribution must preserve dark regions and local contrast instead of lifting the entire frame uniformly.
- Shadow-map and probe updates should be cached or scheduled only after measurement shows a repeatable benefit.

### 4.2 Atmosphere, sky and HDR environment

**Target:** the atmosphere must establish depth and make the world feel like a continuous environment.

- Rayleigh molecular scattering and Mie aerosol scattering.
- Height-dependent volumetric fog with depth-aware integration.
- Atmospheric perspective that increases naturally with distance.
- Sun-elevation-linked sky luminance, environment radiance and HDR image-based lighting (IBL).
- Day, dusk and night states must update sky, direct illumination, environment response, shadow tint and water reflections coherently.
- Volumetric clouds and fog must integrate with scene depth and lighting without introducing visible seams, banding or temporal instability.
- Existing authored panorama appearance remains the visual reference until a replacement is explicitly reviewed.

### 4.3 Water

**Target:** preserve PStudio's signature water-mirror character while making the optical behavior more convincing.

- View-angle Fresnel reflection.
- Beer–Lambert absorption driven by water depth and material absorption coefficients.
- Refraction using scene depth and a stable view-space/world-space convention.
- Multi-scale wave motion with micro-normal detail; large waves and fine ripples must not be collapsed into one frequency.
- Planar reflection for the signature mirror surface, with screen-space techniques used only as a complement where appropriate.
- Reflection clipping, depth handling and camera state must remain correct for each reflection view.
- Temporal reuse may reduce cost, but stale reflections, stretching, excessive blur and visible update cadence are not acceptable.
- Foam, shoreline transitions and caustic detail are secondary to correct reflection, depth, absorption and refraction.

### 4.4 Material identity

**Target:** surfaces must be distinguishable by how they respond to light, not only by base color.

Every material should expose physically meaningful base color, roughness, metalness and normal data, with optional height, occlusion, emissive and transmission features as appropriate.

| Material family | Required character |
|---|---|
| Wet stone | Stone roughness and irregular normals remain visible; a water film changes reflectance without turning the whole surface into mirror-like metal |
| Aged wood | Grain direction, layered roughness, worn edges and restrained moisture response |
| Metal | Correct metallic Fresnel response, roughness variation and fine surface imperfections |
| Rock and soil | Broad shape, medium-scale layering and fine normal detail remain distinct |
| Foliage | Leaf form, translucency/backlighting, roughness and wind response remain coherent |

Texture and shader detail must be scaled by world-space size and viewing distance so that patterns do not shimmer or alias.

## 5. Cinematic compensation and PVCS

PVCS may help retain the intended image while reducing measured cost. It is not a substitute for a sound lighting or material model.

Permitted candidate techniques, subject to measurement and comparison:

- SH/probe reuse and carefully bounded indirect-light compensation.
- Depth-aware aerial-perspective approximations.
- Lower-resolution volumetric integration with edge-aware or temporally stable reconstruction.
- Micro-contrast adjustments that preserve local texture without creating halos.
- Bloom restricted to high-luminance features, with highlight detail retained.
- Reflection and probe update scheduling based on visual importance and scene change.
- Render-target reuse and lifetime management when resource dependencies permit it.

PVCS must evaluate at least three separate dimensions:

1. **Physical coherence:** light transport cues, material response, depth and reflection consistency.
2. **Artistic identity:** color hierarchy, form readability, mood and the intended 55:45 balance.
3. **Runtime cost and stability:** CPU time, GPU time, memory pressure, frame pacing and temporal artifacts.

An improvement in one dimension does not automatically excuse a regression in another. CPU, GPU, asynchronous elapsed time and memory estimates must remain separate. An unavailable GPU measurement must never be inferred from CPU submission time.

Automatic quality actuation remains disabled until the later PVCS allocation phase has repeatable baselines, visual tolerances, reversible actions and hysteresis.

## 6. Reference scenes and evaluation protocol

The primary reference is the existing Japanese shrine environment. It should be reviewed in fixed camera positions and repeatable lighting states.

Required review set:

- Day, dusk and night, with the protected panorama baseline.
- A reflective water view containing architecture, foliage and sky.
- Wet stone, aged wood and metal in the same lighting environment.
- A shaded area beside a directly illuminated area, to test shadow detail and bounce light.
- Near and far objects, to test atmospheric perspective and height fog.
- A controlled camera path, to reveal reflection, shadow, foliage and volumetric instability.

Before comparing captures, match camera transform, scene state, render dimensions, pixel ratio, color space, tone mapping, exposure and effect configuration. Compare both still images and motion sequences.

The review rubric is:

| Dimension | Questions |
|---|---|
| Physical foundation | Do materials, shadows, reflections and atmospheric depth agree? |
| Artistic identity | Is the image beautiful and readable, with the intended Reality 55 : Anime 45 character? |
| Scene consistency | Do sky, sun, environment lighting, water and fog tell the same story? |
| Temporal quality | Do details remain stable during movement and transitions? |
| Performance | Did the measured limiting resource improve without hidden quality loss? |

The 55:45 balance is judged at final-image level through this rubric. It is not presented as a scientifically measurable pixel ratio.

## 7. Phase 1 completion criteria

Phase 1 is complete when:

- The 55:45 principle and its technical interpretation are documented as above.
- Lighting, atmosphere, water, materials and cinematic compensation have explicit target behaviors.
- The shrine reference-scene review set and capture conditions are defined.
- Physical, artistic, temporal and performance evaluations are treated as separate axes.
- No unreviewed runtime quality or rendering changes have been introduced.

## 8. Implementation boundaries

This phase establishes the visual contract. It does not yet replace the renderer or implement the full physical systems. The subsequent engine phases should implement these requirements in the following order:

- Graphics Core and Render Graph: resource and pass foundations.
- Native Renderer: small verified vertical slice.
- Rendering Quality: PBR, shadows, SH indirect light and material response.
- Atmosphere & Sky: physical scattering, height fog and sun-linked HDR IBL.
- Advanced Water: Fresnel, Beer–Lambert absorption, refraction and multi-scale waves.
- World Rendering and Advanced Graphics: material/world scale, volumetrics and advanced effects.
- PVCS: measured visual-quality-preserving allocation.
- Three.js independence: only after parity and regression criteria are satisfied.

No Three.js removal, renderer-backend switch or default quality change is part of Phase 1.
