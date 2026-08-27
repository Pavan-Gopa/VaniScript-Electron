import React, { useEffect, useMemo, useState, useRef } from 'react';
import { AppSettings } from '../types';
import {
  HELP_UI_COPY,
  getHelpTopic,
  getHelpTourDefinition,
  normalizeHelpLanguage,
} from '../../shared/help-catalog';

interface OnboardingTourProps {
  activeScreen: 'upload' | 'config' | 'processing' | 'review' | 'export' | 'settings' | 'alignment-editor';
  settings: AppSettings;
  onToggleAnnotationMode: (enabled: boolean) => void;
  onHelpLocaleChange: (locale: 'en' | 'ru') => void;
  settingsTab?: number;
  onSettingsTabChange?: (tab: number) => void;
}

const BUBBLE_WIDTH = 380;
const BUBBLE_HEIGHT = 180;
type CatalogTourStep = {
  topicStep: number | null;
};

export function OnboardingTour({ activeScreen, settings, onToggleAnnotationMode, onHelpLocaleChange, settingsTab, onSettingsTabChange }: OnboardingTourProps) {
  const [currentStepIdx, setCurrentStepIdx] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [bubblePos, setBubblePos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [windowSize, setWindowSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [draggedPos, setDraggedPos] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ startX: number; startY: number; initialX: number; initialY: number } | null>(null);

  const tourLang = normalizeHelpLanguage(settings.helpLocale);

  const tourDefinition = useMemo(() => getHelpTourDefinition(activeScreen), [activeScreen]);
  const steps = tourDefinition?.steps ?? [];
  const activeStep = steps[currentStepIdx] as (typeof steps[number] & CatalogTourStep) | undefined;
  const activeTopic = activeStep
    ? getHelpTopic({ id: activeStep.topicId, language: tourLang })
    : null;
  const activeContent = activeTopic && activeStep
    ? {
        title: activeTopic.title,
        description: activeStep.topicStep === null
          ? activeTopic.summary
          : activeTopic.steps[activeStep.topicStep],
      }
    : null;


  // Effect to reset step index when screen changes
  useEffect(() => {
    if (!settings.annotationMode) return;
    setCurrentStepIdx(0);
    setDraggedPos(null);
  }, [activeScreen, settings.annotationMode]);

  // Reset dragged position when step index changes
  useEffect(() => {
    if (!settings.annotationMode) return;
    setDraggedPos(null);
  }, [currentStepIdx, settings.annotationMode]);

  // Automatically change settings tab depending on the onboarding step
  useEffect(() => {
    if (!settings.annotationMode) return;
    if (activeScreen === 'settings' && onSettingsTabChange) {
      if (currentStepIdx >= 0 && currentStepIdx <= 8) {
        onSettingsTabChange(currentStepIdx);
      }
    }
  }, [currentStepIdx, activeScreen, onSettingsTabChange, settings.annotationMode]);

  // Handle window resizing, scrolling & interval check for elements rendering
  useEffect(() => {
    if (!settings.annotationMode || !activeStep) return;

    const handleUpdate = () => {
      setWindowSize({ w: window.innerWidth, h: window.innerHeight });
      const element = document.querySelector(activeStep.targetSelector);
      if (element) {
        const rect = element.getBoundingClientRect();
        setTargetRect(rect);

        // Calculate bubble coordinate relative to target rect
        const bubbleWidth = BUBBLE_WIDTH;
        const bubbleHeight = BUBBLE_HEIGHT;
        
        let x = window.innerWidth / 2 - bubbleWidth / 2;
        let y = window.innerHeight / 2 - bubbleHeight / 2;

        const gap = 60; // Generous gap for breathing room (air)
        let placement = activeStep.bubblePlacement;

        // Smart flip collision detection: if there is not enough room, flip to the opposite side
        if (placement === 'bottom') {
          const projectedY = rect.bottom + gap;
          if (projectedY + bubbleHeight > window.innerHeight - 20) {
            placement = 'top';
          }
        } else if (placement === 'top') {
          const projectedY = rect.top - bubbleHeight - gap;
          if (projectedY < 80) {
            placement = 'bottom';
          }
        } else if (placement === 'left') {
          const projectedX = rect.left - bubbleWidth - gap;
          if (projectedX < 20) {
            placement = 'right';
          }
        } else if (placement === 'right') {
          const projectedX = rect.right + gap;
          if (projectedX + bubbleWidth > window.innerWidth - 20) {
            placement = 'left';
          }
        }

        // Apply final coordinates based on placement
        if (placement === 'bottom') {
          x = rect.left + rect.width / 2 - bubbleWidth / 2;
          y = rect.bottom + gap;
        } else if (placement === 'top') {
          x = rect.left + rect.width / 2 - bubbleWidth / 2;
          y = rect.top - bubbleHeight - gap;
        } else if (placement === 'left') {
          x = rect.left - bubbleWidth - gap;
          y = rect.top + rect.height / 2 - bubbleHeight / 2;
        } else if (placement === 'right') {
          x = rect.right + gap;
          y = rect.top + rect.height / 2 - bubbleHeight / 2;
        }

        // Clamp bubble positions to viewport safety boundaries
        x = Math.max(20, Math.min(window.innerWidth - bubbleWidth - 20, x));
        y = Math.max(80, Math.min(window.innerHeight - bubbleHeight - 20, y));

        setBubblePos({ x, y });
      } else {
        setTargetRect(null);
        // Center position if target not found
        setBubblePos({
          x: window.innerWidth / 2 - BUBBLE_WIDTH / 2,
          y: window.innerHeight / 2 - BUBBLE_HEIGHT / 2,
        });
      }
    };

    handleUpdate();

    // Set a quick interval to poll for rendering changes (since pages load dynamically)
    const interval = setInterval(handleUpdate, 350);
    window.addEventListener('resize', handleUpdate);
    window.addEventListener('scroll', handleUpdate, true);

    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', handleUpdate);
      window.removeEventListener('scroll', handleUpdate, true);
    };
  }, [activeStep, currentStepIdx, activeScreen, settings.annotationMode]);

  const handleNext = () => {
    if (currentStepIdx < steps.length - 1) {
      setCurrentStepIdx(currentStepIdx + 1);
    } else {
      // Completed last step on this screen
      onToggleAnnotationMode(false);
    }
  };

  const handlePrev = () => {
    if (currentStepIdx > 0) {
      setCurrentStepIdx(currentStepIdx - 1);
    }
  };

  const handleSkip = () => {
    onToggleAnnotationMode(false);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') || target.closest('.onboarding-lang-switcher')) {
      return;
    }
    // Set ref values
    const startX = e.clientX;
    const startY = e.clientY;
    const initialX = draggedPos ? draggedPos.x : bubblePos.x;
    const initialY = draggedPos ? draggedPos.y : bubblePos.y;
    dragStartRef.current = { startX, startY, initialX, initialY };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!settings.annotationMode || !isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return;
      const { startX, startY, initialX, initialY } = dragStartRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newX = Math.max(10, Math.min(window.innerWidth - BUBBLE_WIDTH - 10, initialX + dx));
      const newY = Math.max(50, Math.min(window.innerHeight - BUBBLE_HEIGHT - 20, initialY + dy));
      setDraggedPos({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, settings.annotationMode]);
  // Disable tour if settings.annotationMode is false or if no steps exist.
  if (!settings.annotationMode || steps.length === 0) {
    return null;
  }

  // Draw arrow path using Bezier curves
  const renderArrow = () => {
    if (!targetRect || !activeStep) return null;

    // Source of arrow: bubble edge facing target
    const bubbleW = BUBBLE_WIDTH;
    const bubbleH = BUBBLE_HEIGHT;
    const currentX = draggedPos ? draggedPos.x : bubblePos.x;
    const currentY = draggedPos ? draggedPos.y : bubblePos.y;

    let sx = currentX + bubbleW / 2;
    let sy = currentY + bubbleH / 2;

    // Target of arrow: target center or closest edge
    let tx = targetRect.left + targetRect.width / 2;
    let ty = targetRect.top + targetRect.height / 2;

    // Dynamically choose starting point on bubble based on relative position to target
    if (ty < currentY) {
      // Target is above bubble
      sx = currentX + bubbleW / 2;
      sy = currentY;
      ty = targetRect.bottom;
    } else if (ty > currentY + bubbleH) {
      // Target is below bubble
      sx = currentX + bubbleW / 2;
      sy = currentY + bubbleH;
      ty = targetRect.top;
    } else if (tx < currentX) {
      // Target is to the left of bubble
      sx = currentX;
      sy = currentY + bubbleH / 2;
      tx = targetRect.right;
    } else {
      // Target is to the right of bubble
      sx = currentX + bubbleW;
      sy = currentY + bubbleH / 2;
      tx = targetRect.left;
    }

    // Dynamic Bezier Control point with organic custom offsets
    const mx = (sx + tx) / 2 + activeStep.arrowCurveOffset.dx;
    const my = (sy + ty) / 2 + activeStep.arrowCurveOffset.dy;

    const pathData = `M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`;

    return (
      <svg className="onboarding-svg-overlay" style={{ width: windowSize.w, height: windowSize.h }}>
        <defs>
          <marker
            id="onboarding-arrowhead"
            markerWidth="10"
            markerHeight="10"
            refX="6"
            refY="3"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L0,6 L8,3 Z" fill="var(--accent)" />
          </marker>
        </defs>
        {/* Draw curved arrow path */}
        <path
          d={pathData}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          strokeDasharray="6 4"
          markerEnd="url(#onboarding-arrowhead)"
          className="onboarding-arrow-path"
        />
      </svg>
    );
  };

  const copy = HELP_UI_COPY[tourLang];
  const currentX = draggedPos ? draggedPos.x : bubblePos.x;
  const currentY = draggedPos ? draggedPos.y : bubblePos.y;

  return (
    <div className="onboarding-tour-root">
      {/* Target spotlight backing */}
      {targetRect && (
        <div
          className="onboarding-spotlight"
          style={{
            top: targetRect.top - 6,
            left: targetRect.left - 6,
            width: targetRect.width + 12,
            height: targetRect.height + 12,
          }}
        />
      )}

      {/* Renders Arrow and Glow rings */}
      {renderArrow()}

      {/* Annotation Handwritten bubble card */}
      <div
        className={`onboarding-bubble ${isDragging ? 'dragging' : ''}`}
        style={{
          left: `${currentX}px`,
          top: `${currentY}px`,
        }}
        onMouseDown={handleMouseDown}
      >
        <div className="onboarding-bubble-header">
          <h4>{activeContent?.title}</h4>
          
          <div className="onboarding-header-controls">
            {/* Interactive language switcher */}
            <div className="onboarding-lang-switcher" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className={tourLang === 'en' ? 'active' : ''}
                onClick={() => onHelpLocaleChange('en')}
                title={copy.english}
              >
                EN
              </button>
              <button
                type="button"
                className={tourLang === 'ru' ? 'active' : ''}
                onClick={() => onHelpLocaleChange('ru')}
                title={copy.russian}
              >
                RU
              </button>
            </div>

            <span className="onboarding-step-counter">
              {copy.step} {currentStepIdx + 1}/{steps.length}
            </span>
          </div>
        </div>
        
        <div className="onboarding-bubble-body">
          <p>{activeContent?.description}</p>
        </div>
        
        <div className="onboarding-bubble-footer">
          <button className="onboarding-btn-skip" onClick={handleSkip}>
            {copy.skipWalkthrough}
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            {currentStepIdx > 0 && (
              <button className="onboarding-btn-prev" onClick={handlePrev}>
                {`‹ ${copy.previous}`}
              </button>
            )}
            <button className="onboarding-btn-next" onClick={handleNext}>
              {currentStepIdx < steps.length - 1 
                ? `${copy.next} ›`
                : copy.finish}
            </button>
          </div>
        </div>
      </div>

      {/* Persistent mini-badge to show the user they can toggle annotations */}
      <div className="onboarding-mini-badge" onClick={() => onToggleAnnotationMode(false)}>
        <span>{copy.helpTour} · {copy.skipWalkthrough}</span>
      </div>
    </div>
  );
}
