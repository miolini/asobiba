// Copyright 2020 Hajime Hoshi
// SPDX-License-Identifier: Apache-2.0

import './wasm_exec.js';
import { stdfiles } from './stdfiles.js';

(() => {
    const statModes = {
        S_IFMT:   0o170000, // bit mask for the file type bit fields
        S_IFSOCK: 0o140000, // socket
        S_IFLNK:  0o120000, // symbolic link
        S_IFREG:  0o100000, // regular file
        S_IFBLK:  0o060000, // block device
        S_IFDIR:  0o040000, // directory
        S_IFCHR:  0o020000, // character device
        S_IFIFO:  0o010000, // FIFO
        S_ISUID:  0o004000, // set UID bit
        S_ISGID:  0o002000, // set-group-ID bit (see below)
        S_ISVTX:  0o001000, // sticky bit (see below)
        S_IRWXU:  0o0700,   // mask for file owner permissions
        S_IRUSR:  0o0400,   // owner has read permission
        S_IWUSR:  0o0200,   // owner has write permission
        S_IXUSR:  0o0100,   // owner has execute permission
        S_IRWXG:  0o0070,   // mask for group permissions
        S_IRGRP:  0o0040,   // group has read permission
        S_IWGRP:  0o0020,   // group has write permission
        S_IXGRP:  0o0010,   // group has execute permission
        S_IRWXO:  0o0007,   // mask for permissions for others (not in group)
        S_IROTH:  0o0004,   // others have read permission
        S_IWOTH:  0o0002,   // others have write permission
        S_IXOTH:  0o0001,   // others have execute permission
    };

    function enosys() {
	const err = new Error('not implemented');
	err.code = 'ENOSYS';
	return err;
    }

    function absPath(cwd, path) {
        if (path[0] === '/') {
            return path;
        }

        const tokens = [];
        path.split('/').filter(t => {
            return t !== '.' && t.length > 0
        }).forEach(s => {
            if (s === '..') {
                tokens.pop();
                return;
            }
            tokens.push(s);
        });
        let wd = cwd;
        if (wd[wd.length-1] !== '/') {
            wd += '/';
        }
        path = wd + tokens.join('/');
        if (path[path.length-1] === '/' && path !== '/') {
            path = path.substring(0, path.length-1);
        }
        return path;
    }

    function dirs(path) {
        const result = [];
        let current = '';
        const tokens = path.split('/');
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (current !== '/') {
                current += '/';
            }
            current += token;
            result.push(current);
        }
        return result;
    }

    class FS {
        constructor(ps) {
            // TODO: What about using localStorage except for /tmp?
            this.files_ = new Map();
            this.fds_ = new Map();
            this.ps_ = ps;
            this.nextFd_ = 1000;
            this.stdout_ = '';
            this.stderr_ = '';

            this.files_.set('/', {
                directory: true,
            });
            this.files_.set('/tmp', {
                directory: true,
            });
            this.files_.set('/root', {
                directory: true,
            });
            // GOPATH
            this.files_.set('/root/go', {
                directory: true,
            });

            const goroot = '/go'
            this.files_.set(goroot, {
                directory: true,
            });

            // stdlib files
            // TODO: Load them lazily
            const encoder = new TextEncoder();
            for (const filename of Object.keys(stdfiles)) {
                const fullfn = goroot + '/src/' + filename;
                const dir = fullfn.substring(0, fullfn.lastIndexOf('/'));
                this.mkdirp_(dir);
                this.files_.set(fullfn, {
                    content: encoder.encode(atob(stdfiles[filename])),
                });
            }
        }

        get constants() {
            return {
                O_WRONLY: 1 << 0,
                O_RDWR:   1 << 1,
                O_CREAT:  1 << 2,
                O_TRUNC:  1 << 3,
                O_APPEND: 1 << 4,
                O_EXCL:   1 << 5,
            };
        }

        writeSync(fd, buf) {
            if (fd === 1) {
                this.stdout_ += new TextDecoder('utf-8').decode(buf);
                for (;;) {
                    const n = this.stdout_.indexOf('\n');
                    if (n < 0) {
                        break;
                    }
                    console.log(this.stdout_.substring(0, n));
                    this.stdout_ = this.stdout_.substring(n+1);
                }
                return buf.length;
            }
            if (fd === 2) {
                this.stderr_ += new TextDecoder('utf-8').decode(buf);
                for (;;) {
                    const n = this.stderr_.indexOf('\n');
                    if (n < 0) {
                        break;
                    }
                    console.warn(this.stderr_.substring(0, n));
                    this.stderr_ = this.stderr_.substring(n+1);
                }
                return buf.length;
            }

            const handle = this.fds_.get(fd);
            let content = this.files_.get(handle.path).content;
            let finalLength = handle.offset + buf.length;

            // Extend the size if necessary
            let n = content.buffer.byteLength;
            if (n === 0) {
                n = 1024;
            }
            while (n < finalLength) {
                n *= 2;
            }
            if (content.buffer.byteLength !== n) {
                const old = content;
                content = new Uint8Array(new ArrayBuffer(n), 0, finalLength);
                content.set(old);
            } else {
                content = new Uint8Array(content.buffer, 0, finalLength);
            }

            content.set(buf, handle.offset)

            handle.offset += buf.length;
            this.files_.get(handle.path).content = content;

            return buf.length;
        }

        write(fd, buf, offset, length, position, callback) {
            if (offset !== 0 || length !== buf.length || position !== null) {
                // TOOD: Implement this.
                callback(enosys());
                return;
            }
            const n = this.writeSync(fd, buf);
            callback(null, n);
        }

        chmod(path, mode, callback) {
            callback(null);
        }

	chown(path, uid, gid, callback) {
            callback(null);
        }

	close(fd, callback) {
            this.fds_.delete(fd);
            callback(null);
        }

	fchmod(fd, mode, callback) {
            callback(null);
        }

	fchown(fd, uid, gid, callback) {
            callback(null);
        }

	fstat(fd, callback) {
            this.stat_(this.fds_.get(fd).path, callback);
        }

	fsync(fd, callback) {
            callback(null);
        }

	ftruncate(fd, length, callback) {
            // TODO: Implement this?
            callback(enosys());
        }

	lchown(path, uid, gid, callback) {
            callback(null);
        }

	link(path, link, callback) {
            callback(enosys());
        }

	lstat(path, callback) {
            this.stat_(path, callback);
        }

	mkdir(path, perm, callback) {
            path = absPath(this.ps_.cwd(), path);
            const ds = dirs(path);
            for (let i = 0; i < ds.length; i++) {
                const file = this.files_.get(ds[i]);
                if (!file) {
                    if (i !== ds.length - 1) {
                        const err = new Error('file exists');
                        err.code = 'EEXIST';
                        callback(err);
                        return;
                    }
                    break;
                }
                if (!file.directory) {
                    const err = new Error('file exists');
                    err.code = 'EEXIST';
                    callback(err);
                    return;
                }
            }
            this.files_.set(path, {
                directory: true,
            });
            callback(null);
        }

	open(path, flags, mode, callback) {
            path = absPath(this.ps_.cwd(), path);
            if (!this.files_.has(path)) {
                if (!(flags & this.constants.O_CREAT)) {
                    const err = new Error('no such file or directory');
                    err.code = 'ENOENT';
                    callback(err);
                    return;
                }
                this.files_.set(path, {
                    content:   new Uint8Array(0),
                    directory: false,
                });
            }
            // TODO: Abort if path is a directory.
            if (flags & this.constants.O_TRUNC) {
                this.files_.set(path, {
                    content:   new Uint8Array(0),
                    directory: false,
                });
            }

            const fd = this.nextFd_;
            this.nextFd_++;
            this.fds_.set(fd, {
                path:   path,
                offset: 0,
            });
            callback(null, fd);
        }

	read(fd, buffer, offset, length, position, callback) {
            const handle = this.fds_.get(fd);
            if (position !== null) {
                handle.offset = position;
            }

            const content = this.files_.get(handle.path).content;
            let n = length;
            if (handle.offset + length > content.byteLength) {
                n = content.byteLength - handle.offset;
            }
            if (n > buffer.length - offset) {
                n = buffer.length - offset;
            }

            for (let i = 0; i < n; i++) {
                buffer[offset+i] = content[handle.offset+i];
            }

            handle.offset += n;
            callback(null, n);
        }

	readdir(path, callback) {
            path = absPath(this.ps_.cwd(), path);
            const filenames = this.filenamesAt_(path);
            callback(null, filenames);
        }

	readlink(path, callback) {
            callback(enosys());
        }

	rename(from, to, callback) {
            // TODO: Implement this?
            callback(enosys());
        }

	rmdir(path, callback) {
            // TODO: Implement this?
            callback(enosys());
        }

	stat(path, callback) {
            this.stat_(path, callback);
        }

	symlink(path, link, callback) {
            // TODO: Implement this?
            callback(enosys());
        }

	truncate(path, length, callback) {
            // TODO: Implement this?
            callback(enosys());
        }

	unlink(path, callback) {
            // TODO: Mark the file removed and remove it later.
            callback(null);
        }

	utimes(path, atime, mtime, callback) {
            callback(enosys());
        }

        stat_(path, callback) {
            path = absPath(this.ps_.cwd(), path);
            if (!this.files_.has(path)) {
                const err = new Error('no such file or directory');
                err.code = 'ENOENT';
                callback(err);
                return;
            }
            let mode = 0;
            const file = this.files_.get(path);
            if (file.directory) {
                mode |= statModes.S_IFDIR;
            }
            callback(null, {
                mode:    mode,
                dev:     0,
                ino:     0,
                nlink:   0,
                uid:     0,
                gid:     0,
                rdev:    0,
                size:    0,
                blksize: 0,
                blocks:  0,
                atimeMs: 0,
                mtimeMs: 0,
                ctimeMs: 0,
                isDirectory: () => !!(mode & statModes.S_IFDIR),
            });
        }

        mkdirp_(dir) {
            for (const path of dirs(dir)) {
                const file = this.files_.get(path);
                if (file) {
                    if (file.directory) {
                        continue;
                    }
                    const err = new Error('file exists');
                    err.code = 'EEXIST';
                    throw err;
                }
                this.files_.set(path, {
                    directory: true,
                });
            }
        }

        filenamesAt_(dir) {
            const result = [];
            for (const key of this.files_.keys()) {
                if (key === dir)
                    continue;
                if (!key.startsWith(dir))
                    continue;
                const filename = key.substring(dir.length+1);
                if (filename.indexOf('/') >= 0)
                    continue;
                result.push(filename);
            }
            return result;
        }

        addWorkingDirectory_(dir, files) {
            this.mkdirp_(dir)
            // TODO: Consider the case when the files include directories.
            for (const filename of Object.keys(files)) {
                const path = dir + '/' + filename;
                this.files_.set(path, {
                    content:   files[filename],
                    directory: false,
                })
            }
        }

        removeWorkingDirectory_(dir) {
            // TODO: Implement this
        }
    }

    class Process {
        constructor() {
            this.wd_ = '/root';
        }

        getuid() { return -1; }
	getgid() { return -1; }
	geteuid() { return -1; }
	getegid() { return -1; }
	getgroups() { throw enosys(); }
	get pid() { return -1; }
	get ppid() { -1; }
	umask() { throw enosys(); }

        cwd() {
            return this.wd_;
        }

	chdir(dir) {
            this.wd_ = absPath(this.wd_, dir);
        }
    }

    const process = new Process();
    const fs = new FS(process);
    window.fs = fs;
    window.process = process;
})();

function randomToken() {
    let result = '';
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 12; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export function execGo(argv, files) {
    return new Promise((resolve, reject) => {
        // Polyfill
        let instantiateStreaming = WebAssembly.instantiateStreaming;
        if (!instantiateStreaming) {
            instantiateStreaming = async (resp, importObject) => {
                const source = await (await resp).arrayBuffer();
                return await WebAssembly.instantiate(source, importObject);
            };
        }

        // TODO: Detect collision.
        const wd = '/tmp/wd-' + randomToken();
        window.fs.addWorkingDirectory_(wd, files);
        window.process.chdir(wd);

        // Note: go1.14beta1.wasm is created by this command:
        //
        //    cd [go source]/src/cmd/go
        //    GOOS=js GOARCH=wasm go1.14beta1 build -trimpath -o=go1.14beta1.wasm .
        const go = new Go();
        instantiateStreaming(fetch("go1.14beta1.wasm"), go.importObject).then(result => {
            go.exit = resolve;
            go.argv = go.argv.concat(argv || []);
            go.env = {
                TMPDIR:      '/tmp',
                HOME:        '/root',
                GOROOT:      '/go',
                GO111MODULE: 'on',
            };
            go.run(result.instance);
        }).catch(reject).finally(() => {
            window.fs.removeWorkingDirectory_(wd);
        });
    })
}
