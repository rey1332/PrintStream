import React from 'react';
import Image from 'next/image';

const SRC = '/assets/images/betty-logo.png';
const CANVAS = { width: 1050, height: 600 };
const FRAME = { x: 492, y: 233, width: 68, height: 94 };

interface SidebarLogoProps {
  height?: number;
  alt?: string;
  className?: string;
}

export default function SidebarLogo({
  height = 28,
  alt = 'ETNA',
  className = '',
}: SidebarLogoProps) {
  const scale = height / FRAME.height;
  return (
    <span
      className={['relative inline-block flex-shrink-0 overflow-hidden', className].join(' ')}
      style={{ width: FRAME.width * scale, height }}
    >
      <Image
        src={SRC}
        alt={alt}
        width={CANVAS.width}
        height={CANVAS.height}
        priority
        unoptimized
        draggable={false}
        className="absolute max-w-none select-none"
        style={{
          width: CANVAS.width * scale,
          height: CANVAS.height * scale,
          left: -FRAME.x * scale,
          top: -FRAME.y * scale,
        }}
      />
    </span>
  );
}
