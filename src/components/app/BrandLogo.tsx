import Image from "next/image";

export function BrandLogo({
  className = "h-20 w-auto max-w-[180px]",
  zoomClassName = "scale-[1.16]",
  priority = false,
}: {
  className?: string;
  zoomClassName?: string;
  priority?: boolean;
}) {
  return (
    <Image
      src="/image.png"
      alt="WSA Global"
      width={1280}
      height={853}
      // (shown at 250 CSS px at most, up to ~390 px with the zoom: without `sizes` the browser was handed the 1280 - 1920 px
      // variant of the picture for it)
      sizes="400px"
      priority={priority}
      className={`${className} ${zoomClassName} transform-gpu object-contain`}
    />
  );
}
