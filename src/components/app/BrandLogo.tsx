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
      priority={priority}
      className={`${className} ${zoomClassName} transform-gpu object-contain`}
    />
  );
}
