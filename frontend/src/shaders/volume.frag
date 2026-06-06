precision highp float;
precision highp sampler3D;
precision highp sampler2D;

uniform sampler3D uVolumeData;
uniform sampler2D uColormap;
uniform vec3 uVolumeSize;
uniform vec3 uVolumeDimensions;
uniform float uSampleRate;
uniform float uOpacity;
uniform float uBrightness;
uniform float uContrast;
uniform float uThreshold;
uniform vec3 uCameraPos;
uniform vec3 uBoundsMin;
uniform vec3 uBoundsMax;
uniform float uMinValue;
uniform float uMaxValue;

uniform bool uEnableClipping;
uniform vec3 uClipPlaneNormal;
uniform float uClipPlaneConstant;

varying vec3 vWorldPosition;
varying vec3 vLocalPosition;
varying vec2 vUv;

float distanceToPlane(vec3 point, vec3 normal, float constant) {
  return dot(normal, point) + constant;
}

bool isBehindClipPlane(vec3 point) {
  if (!uEnableClipping) return false;
  return distanceToPlane(point, uClipPlaneNormal, uClipPlaneConstant) > 0.001;
}

bool intersectBox(vec3 ro, vec3 rd, vec3 boxMin, vec3 boxMax, out float tNear, out float tFar) {
  vec3 invR = 1.0 / rd;
  vec3 tbot = invR * (boxMin - ro);
  vec3 ttop = invR * (boxMax - ro);
  vec3 tmin = min(ttop, tbot);
  vec3 tmax = max(ttop, tbot);
  vec2 t = max(tmin.xx, tmin.yz);
  tNear = max(t.x, t.y);
  t = min(tmax.xx, tmax.yz);
  tFar = min(t.x, t.y);
  return tNear < tFar && tFar > 0.0;
}

bool intersectRayPlane(vec3 ro, vec3 rd, vec3 planeNormal, float planeConstant, out float t) {
  float denom = dot(planeNormal, rd);
  if (abs(denom) < 1e-6) return false;
  t = -(dot(planeNormal, ro) + planeConstant) / denom;
  return t >= 0.0;
}

vec3 localToUvw(vec3 localPos, vec3 boundsMin, vec3 boundsMax) {
  return (localPos - boundsMin) / (boundsMax - boundsMin);
}

float sampleVolume(vec3 uvw) {
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) {
    return 0.0;
  }
  return texture(uVolumeData, uvw).r;
}

vec4 applyColormap(float value, float minVal, float maxVal) {
  float normalized = (value - minVal) / (maxVal - minVal);
  normalized = clamp(normalized, 0.0, 1.0);
  return texture2D(uColormap, vec2(normalized, 0.5));
}

float applyBrightnessContrast(float value, float brightness, float contrast) {
  value = (value - 0.5) * contrast + 0.5;
  value = value + brightness;
  return clamp(value, 0.0, 1.0);
}

void main() {
  vec3 ro = uCameraPos;
  vec3 rd = normalize(vWorldPosition - ro);
  
  float tNear, tFar;
  if (!intersectBox(ro, rd, uBoundsMin, uBoundsMax, tNear, tFar)) {
    discard;
  }
  
  tNear = max(tNear, 0.0);
  
  vec3 startPos = ro + rd * tNear;
  vec3 endPos = ro + rd * tFar;
  
  if (uEnableClipping) {
    float tPlane;
    if (intersectRayPlane(ro, rd, uClipPlaneNormal, uClipPlaneConstant, tPlane)) {
      if (tPlane > tNear && tPlane < tFar) {
        if (isBehindClipPlane(startPos)) {
          startPos = ro + rd * tPlane;
        } else {
          endPos = ro + rd * tPlane;
        }
      }
    }
    
    if (isBehindClipPlane(startPos) && isBehindClipPlane(endPos)) {
      discard;
    }
  }
  
  float stepSize = uSampleRate * 0.5;
  vec3 step = rd * stepSize;
  
  float maxDist = length(endPos - startPos);
  int maxSteps = int(maxDist / stepSize);
  maxSteps = min(maxSteps, 512);
  
  vec4 accumulatedColor = vec4(0.0);
  
  vec3 currentPos = startPos;
  
  for (int i = 0; i < 512; i++) {
    if (i >= maxSteps) break;
    if (accumulatedColor.a >= 0.95) break;
    
    if (isBehindClipPlane(currentPos)) {
      currentPos += step;
      continue;
    }
    
    vec3 uvw = localToUvw(currentPos, uBoundsMin, uBoundsMax);
    float density = sampleVolume(uvw);
    
    if (density > uThreshold) {
      float normalizedDensity = (density - uMinValue) / (uMaxValue - uMinValue);
      normalizedDensity = applyBrightnessContrast(normalizedDensity, uBrightness, uContrast);
      
      vec4 sampleColor = applyColormap(density, uMinValue, uMaxValue);
      sampleColor.a = normalizedDensity * uOpacity * stepSize * 2.0;
      
      sampleColor.rgb *= sampleColor.a;
      accumulatedColor += sampleColor * (1.0 - accumulatedColor.a);
    }
    
    currentPos += step;
  }
  
  if (accumulatedColor.a < 0.01) {
    discard;
  }
  
  gl_FragColor = vec4(accumulatedColor.rgb, accumulatedColor.a);
}
