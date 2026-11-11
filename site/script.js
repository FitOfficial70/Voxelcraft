// --- POINTER LOCK & MOUSE ENGINE ---

// Click canvas to lock mouse and hide cursor
canvas.addEventListener('click', () => {
    canvas.requestPointerLock = canvas.requestPointerLock || canvas.mozRequestPointerLock;
    canvas.requestPointerLock();
});

// Listener to track mouse movement when locked
document.addEventListener('pointerlockchange', lockChangeAlert, false);
document.addEventListener('mozpointerlockchange', lockChangeAlert, false);

let isPointerLocked = false;
let cameraYaw = 0;   // Left / Right rotation
let cameraPitch = 0; // Up / Down rotation

function lockChangeAlert() {
    if (document.pointerLockElement === canvas || document.mozPointerLockElement === canvas) {
        console.log('The pointer lock status is now LOCKED');
        isPointerLocked = true;
        document.addEventListener("mousemove", updateCameraRotation, false);
    } else {
        console.log('The pointer lock status is now UNLOCKED');
        isPointerLocked = false;
        document.removeEventListener("mousemove", updateCameraRotation, false);
    }
}

// Function that handles looking around while mouse is invisible
function updateCameraRotation(e) {
    if (!isPointerLocked) return;

    // e.movementX and e.movementY give raw mouse deltas, not absolute positions
    const sensitivity = 0.002; // Adjust this to match your preferred Roblox or Minecraft look speed
    
    cameraYaw += e.movementX * sensitivity;
    cameraPitch -= e.movementY * sensitivity;

    // Clamp vertical looking so the player can't flip upside down (90 degrees max up/down)
    const maxPitch = Math.PI / 2 - 0.05; 
    if (cameraPitch > maxPitch) cameraPitch = maxPitch;
    if (cameraPitch < -maxPitch) cameraPitch = -maxPitch;
}





// in updateMapDisplay, replace the highestBlocks block with:
if (!chunk.topCache) {
    const highestBlocks = new Map();
    for (const block of chunk.blocks) {
        const [lx, y, lz] = block.split(',').map(Number);
        const column = `${lx},${lz}`;
        if (!highestBlocks.has(column) || highestBlocks.get(column).y < y) highestBlocks.set(column, { y, lx, lz });
    }
    chunk.topCache = [...highestBlocks.values()];
}
for (const { y, lx, lz } of chunk.topCache) { /* your existing drawing code */ }




chunks.set(job.key, job.chunk);
chunkGenerationJob = null;
rebuildChunk(job.chunk);
for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const neighbor = chunks.get(chunkKey(job.cx + dx, job.cz + dz));
    if (neighbor) rebuildChunk(neighbor);
}




const chunk = chunks.get(chunkKey(cx, cz));
if (chunk) { chunk.blocks.add(`...`); changedChunks.add(chunk); }
placedBlockTypes.set(worldKey(x, y, z), 'netherPortal');




document.getElementById('touch-break-btn').addEventListener('click', () => breakTargetBlock());
document.getElementById('touch-place-btn').addEventListener('click', () => placeSelectedBlock());