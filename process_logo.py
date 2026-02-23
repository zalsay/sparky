import math
from PIL import Image, ImageDraw

def create_squircle_mask(size, radius_ratio=0.22):
    """
    Creates a macOS-style squircle mask.
    The squircle formula is roughly (x/a)^4 + (y/b)^4 = 1,
    but a simple rounded rectangle is a good approximation for standard usage if we don't need perfect pixel-match to system icons.
    However, Apple's squircle is a bit more complex. Let's use a standard rounded rectangle with high quality.
    
    Standard macOS icon corner radius is ~22.5% of the size.
    For 1024px, radius is ~230px.
    """
    width, height = size
    mask = Image.new('L', size, 0)
    draw = ImageDraw.Draw(mask)
    
    # Rounded rectangle
    # Radius ~ 22% of width
    radius = int(min(width, height) * radius_ratio)
    
    # Draw rounded rectangle
    draw.rounded_rectangle([(0, 0), (width, height)], radius=radius, fill=255)
    
    return mask

def process_logo(input_path, output_path):
    try:
        # Open image
        with Image.open(input_path) as img:
            # Convert to RGBA
            img = img.convert("RGBA")
            
            # Resize to 1024x1024 (standard base size for icons)
            # Use high quality resampling
            target_size = (1024, 1024)
            if img.size != target_size:
                print(f"Resizing from {img.size} to {target_size}...")
                img = img.resize(target_size, Image.Resampling.LANCZOS)
            
            # Create mask
            mask = create_squircle_mask(target_size)
            
            # Apply mask
            result = Image.new("RGBA", target_size)
            result.paste(img, (0, 0), mask=mask)
            
            # Save
            result.save(output_path, "PNG")
            print(f"Successfully saved processed logo to {output_path}")
            
    except Exception as e:
        print(f"Error processing image: {e}")
        exit(1)

if __name__ == "__main__":
    input_file = "logo.png"
    output_file = "logo_processed.png"
    process_logo(input_file, output_file)
