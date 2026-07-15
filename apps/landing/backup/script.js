// Octave Page JavaScript - Matrix Hacker Background

document.addEventListener('DOMContentLoaded', function() {
    console.log('Octave Page가 로드되었습니다!');

    // Matrix Rain Effect
    const canvas = document.getElementById('matrix-bg');
    const ctx = canvas.getContext('2d');

    // Set canvas size
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Characters for the matrix effect - mix of katakana, latin, and numbers
    const characters = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()';
    const fontSize = 12;
    const columns = canvas.width / fontSize;

    // Array to track the y position of each column
    const drops = [];
    for (let i = 0; i < columns; i++) {
        drops[i] = Math.random() * -100; // Start with random positions
    }

    // Drawing function
    function draw() {
        // Semi-transparent black to create trailing effect
        ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Darker green text
        ctx.fillStyle = '#2F5139';
        ctx.font = fontSize + 'px monospace';

        // Loop through drops
        for (let i = 0; i < drops.length; i++) {
            // Random character
            const text = characters.charAt(Math.floor(Math.random() * characters.length));

            // Draw the character
            ctx.fillText(text, i * fontSize, drops[i] * fontSize);

            // Reset drop to top randomly after it crosses the screen
            if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
                drops[i] = 0;
            }

            // Move the drop down
            drops[i]++;
        }
    }

    // Animate the matrix
    setInterval(draw, 33); // ~30 FPS

    // Resize canvas when window is resized
    window.addEventListener('resize', function() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        // Recalculate columns
        const newColumns = canvas.width / fontSize;
        drops.length = newColumns;
        for (let i = 0; i < newColumns; i++) {
            if (drops[i] === undefined) {
                drops[i] = Math.random() * -100;
            }
        }
    });
});

