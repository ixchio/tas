import { Transform } from 'stream';

export class Throttle extends Transform {
    constructor(bytesPerSecond) {
        super();
        this.bytesPerSecond = bytesPerSecond;
        this.passed = 0;
        this.startTime = Date.now();
    }

    _transform(chunk, encoding, callback) {
        this.passed += chunk.length;
        const elapsed = Date.now() - this.startTime;
        const expectedTime = (this.passed / this.bytesPerSecond) * 1000;

        if (expectedTime > elapsed) {
            setTimeout(() => {
                this.push(chunk);
                callback();
            }, expectedTime - elapsed);
        } else {
            this.push(chunk);
            callback();
        }
    }
}
