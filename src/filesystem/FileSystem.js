/*
 * GNU AGPL-3.0 License
 *
 * Copyright (c) 2021 - present core.ai . All rights reserved.
 * Original work Copyright (c) 2013 - 2021 Adobe Systems Incorporated. All rights reserved.
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see https://opensource.org/licenses/AGPL-3.0.
 *
 */

/*global Phoenix*/

/**
 * FileSystem is a model object representing a complete file system. This object creates
 * and manages File and Directory instances, dispatches events when the file system changes,
 * and provides methods for showing 'open' and 'save' dialogs.
 *
 * FileSystem automatically initializes when loaded. It depends on a pluggable "impl" layer, which
 * it loads itself but must be designated in the require.config() that loads FileSystem. For details
 * see: https://github.com/adobe/brackets/wiki/File-System-Implementations
 *
 * There are three ways to get File or Directory instances:
 *    * Use FileSystem.resolve() to convert a path to a File/Directory object. This will only
 *      succeed if the file/directory already exists.
 *    * Use FileSystem.getFileForPath()/FileSystem.getDirectoryForPath() if you know the
 *      file/directory already exists, or if you want to create a new entry.
 *    * Use Directory.getContents() to return all entries for the specified Directory.
 *
 * All paths passed *to* FileSystem APIs must be in the following format:
 *    * The path separator is "/" regardless of platform
 *    * Paths begin with "/" on Mac/Linux and "c:/" (or some other drive letter) on Windows
 *
 * All paths returned *from* FileSystem APIs additionally meet the following guarantees:
 *    * No ".." segments
 *    * No consecutive "/"s
 *    * Paths to a directory always end with a trailing "/"
 * (Because FileSystem normalizes paths automatically, paths passed *to* FileSystem do not need
 * to meet these requirements)
 *
 * FileSystem dispatches the following events:
 * (NOTE: attach to these events via `FileSystem.on()` - not `$(FileSystem).on()`)
 *
 * __change__ - Sent whenever there is a change in the file system. The handler
 *   is passed up to three arguments: the changed entry and, if that changed entry
 *   is a Directory, a list of entries added to the directory and a list of entries
 *   removed from the Directory. The entry argument can be:
 *   *  a File - the contents of the file have changed, and should be reloaded.
 *   *  a Directory - an immediate child of the directory has been added, removed,
 *      or renamed/moved. Not triggered for "grandchildren".
 *      - If the added & removed arguments are null, we don't know what was added/removed:
 *        clients should assume the whole subtree may have changed.
 *      - If the added & removed arguments are 0-length, there's no net change in the set
 *        of files but a file may have been replaced: clients should assume the contents
 *        of any immediate child file may have changed.
 *   *  null - a 'wholesale' change happened, and you should assume everything may
 *      have changed.
 *   For changes made externally, there may be a significant delay before a "change" event
 *   is dispatched.
 *
 * __rename__ - Sent whenever a File or Directory is renamed. All affected File and Directory
 *   objects have been updated to reflect the new path by the time this event is dispatched.
 *   This event should be used to trigger any UI updates that may need to occur when a path
 *   has changed. Note that these events will only be sent for rename operations that happen
 *   within the filesystem. If a file is renamed externally, a change event on the parent
 *   directory will be sent instead.
 *
 * FileSystem may perform caching. But it guarantees:
 *    * File contents & metadata - reads are guaranteed to be up to date (cached data is not used
 *      without first veryifying it is up to date).
 *    * Directory structure / file listing - reads may return cached data immediately, which may not
 *      reflect external changes made recently. (However, changes made via FileSystem itself are always
 *      reflected immediately, as soon as the change operation's callback signals success).
 *
 * The FileSystem doesn't directly read or write contents--this work is done by a low-level
 * implementation object. This allows client code to use the FileSystem API without having to
 * worry about the underlying storage, which could be a local filesystem or a remote server.
 */
define(function (require, exports, module) {


    const Directory       = require("filesystem/Directory"),
        File            = require("filesystem/File"),
        FileIndex       = require("filesystem/FileIndex"),
        FileSystemError = require("filesystem/FileSystemError"),
        RemoteFile      = require("filesystem/RemoteFile"),
        WatchedRoot     = require("filesystem/WatchedRoot"),
        EventDispatcher = require("utils/EventDispatcher"),
        PathUtils       = require("thirdparty/path-utils/path-utils"),
        _               = require("thirdparty/lodash");


    // Collection of registered protocol adapters
    let _fileProtocolPlugins = {};
    const MAX_DEDUPE_NUMBER = 1000; // Eg: folder (copy 1000)

    /**
     * Typical signature of a file protocol adapter.
     * @typedef {Object} FileProtocol~Adapter
     * @property {Number} priority - Indicates the priority.
     * @property {Object} fileImpl - Handle for the custom file implementation prototype.
     * @property {function} canRead - To check if this impl can read a file for a given path.
     */

    /**
     * FileSystem hook to register file protocol adapter
     * @param {string} protocol ex: "https:"|"http:"|"ftp:"|"file:"
     * @param {...FileProtocol~Adapter} adapter wrapper over file implementation
     */
    function registerProtocolAdapter(protocol, adapter) {
        var adapters;
        if (protocol) {
            adapters = _fileProtocolPlugins[protocol] || [];
            adapters.push(adapter);

            // We will keep a sorted adapter list on 'priority'
            // If priority is not provided a default of '0' is assumed
            adapters.sort(function (a, b) {
                return (b.priority || 0) - (a.priority || 0);
            });

            _fileProtocolPlugins[protocol] = adapters;
        }
    }

    /**
     * @param {string} protocol ex: "https:"|"http:"|"ftp:"|"file:"
     * @param {string} filePath fullPath of the file
     * @return adapter adapter wrapper over file implementation
     */
    function _getProtocolAdapter(protocol, filePath) {
        var protocolAdapters = _fileProtocolPlugins[protocol] || [],
            selectedAdapter;

        // Find the fisrt compatible adapter having highest priority
        _.forEach(protocolAdapters, function (adapter) {
            if (adapter.canRead && adapter.canRead(filePath)) {
                selectedAdapter = adapter;
                // Break at first compatible adapter
                return false;
            }
        });

        return selectedAdapter;
    }

    /**
     * The FileSystem is not usable until init() signals its callback.
     * @constructor
     */
    function FileSystem() {
        // Create a file index
        this._index = new FileIndex();

        // Initialize the set of watched roots
        this._watchedRoots = {};

        // Initialize the watch/unwatch request queue
        this._watchRequests = [];

        // Initialize the queue of pending external changes
        this._externalChanges = [];
    }
    EventDispatcher.makeEventDispatcher(FileSystem.prototype);

    /**
     * The low-level file system implementation used by this object.
     * This is set in the init() function and cannot be changed.
     */
    FileSystem.prototype._impl = null;

    /**
     * The FileIndex used by this object. This is initialized in the constructor.
     */
    FileSystem.prototype._index = null;

    /**
     * Refcount of any pending filesystem mutation operations (e.g., writes,
     * unlinks, etc.). Used to ensure that external change events aren't processed
     * until after index fixups, operation-specific callbacks, and internal change
     * events are complete. (This is important for distinguishing rename from
     * an unrelated delete-add pair).
     * @type {number}
     */
    FileSystem.prototype._activeChangeCount = 0;

    // For unit testing only
    FileSystem.prototype._getActiveChangeCount = function () {
        return this._activeChangeCount;
    };

    /**
     * Queue of arguments with which to invoke _handleExternalChanges(); triggered
     * once _activeChangeCount drops to zero.
     * @type {!Array.<{path:?string, stat:FileSystemStats=}>}
     */
    FileSystem.prototype._externalChanges = null;

    /** Process all queued watcher results, by calling _handleExternalChange() on each */
    FileSystem.prototype._triggerExternalChangesNow = function () {
        this._externalChanges.forEach(function (info) {
            this._handleExternalChange(info.path, info.stat);
        }, this);
        this._externalChanges.length = 0;
    };

    /**
     * Receives a result from the impl's watcher callback, and either processes it
     * immediately (if _activeChangeCount is 0) or otherwise stores it for later
     * processing.
     * @param {?string} path The fullPath of the changed entry
     * @param {FileSystemStats=} stat An optional stat object for the changed entry
     */
    FileSystem.prototype._enqueueExternalChange = function (path, stat) {
        this._externalChanges.push({path: path, stat: stat});
        if (!this._activeChangeCount) {
            this._triggerExternalChangesNow();
        }
    };


    /**
     * The queue of pending watch/unwatch requests.
     * @type {Array.<{fn: function(), cb: function()}>}
     */
    FileSystem.prototype._watchRequests = null;

    /**
     * Dequeue and process all pending watch/unwatch requests
     */
    FileSystem.prototype._dequeueWatchRequest = function () {
        if (this._watchRequests.length > 0) {
            var request = this._watchRequests[0];

            request.fn.call(null, function () {
                // Apply the given callback
                var callbackArgs = arguments;
                try {
                    request.cb.apply(null, callbackArgs);
                } finally {
                    // Process the remaining watch/unwatch requests
                    this._watchRequests.shift();
                    this._dequeueWatchRequest();
                }
            }.bind(this));
        }
    };

    /**
     * Enqueue a new watch/unwatch request.
     *
     * @param {function()} fn - The watch/unwatch request function.
     * @param {callback()} cb - The callback for the provided watch/unwatch
     *      request function.
     */
    FileSystem.prototype._enqueueWatchRequest = function (fn, cb) {
        // Enqueue the given watch/unwatch request
        this._watchRequests.push({fn: fn, cb: cb});

        // Begin processing the queue if it is not already being processed
        if (this._watchRequests.length === 1) {
            this._dequeueWatchRequest();
        }
    };

    /**
     * The set of watched roots, encoded as a mapping from full paths to WatchedRoot
     * objects which contain a file entry, filter function, and an indication of
     * whether the watched root is inactive, starting up or fully active.
     *
     * @type {Object.<string, WatchedRoot>}
     */
    FileSystem.prototype._watchedRoots = null;

    /**
     * Finds a parent watched root for a given path, or returns null if a parent
     * watched root does not exist.
     *
     * @param {string} fullPath The child path for which a parent watched root is to be found
     * @return {?{entry: FileSystemEntry, filter: function(string) boolean}} The parent
     *      watched root, if it exists, or null.
     */
    FileSystem.prototype._findWatchedRootForPath = function (fullPath) {
        var watchedRoot = null;

        Object.keys(this._watchedRoots).some(function (watchedPath) {
            if (fullPath.indexOf(watchedPath) === 0) {
                watchedRoot = this._watchedRoots[watchedPath];
                return true;
            }
        }, this);

        return watchedRoot;
    };

    /**
     * Helper function to watch or unwatch a filesystem entry beneath a given
     * watchedRoot.
     *
     * @private
     * @param {FileSystemEntry} entry - The FileSystemEntry to watch. Must be a
     *      non-strict descendent of watchedRoot.entry.
     * @param {WatchedRoot} watchedRoot - See FileSystem._watchedRoots.
     * @param {function(?string)} callback - A function that is called once the
     *      watch is complete, possibly with a FileSystemError string.
     * @param {boolean} shouldWatch - Whether the entry should be watched (true)
     *      or unwatched (false).
     */
    FileSystem.prototype._watchOrUnwatchEntry = function (entry, watchedRoot, callback, shouldWatch) {
        const impl = this._impl,
            commandName = shouldWatch ? "watchPath" : "unwatchPath",
            filterGitIgnore = watchedRoot.filterGitIgnore;

        // The impl can watch the entire subtree with one call on the root (we also fall into this case for
        // unwatch, although that never requires us to do the recursion - see similar final case below)
        if (entry !== watchedRoot.entry) {
            // Watch and unwatch calls to children of the watched root are
            // no-ops if the impl supports recursiveWatch
            callback(null);
        } else {
            // The impl will handle finding all subdirectories to watch.
            this._enqueueWatchRequest(function (requestCb) {
                impl[commandName].call(impl, entry.fullPath, filterGitIgnore, requestCb);
            }.bind(this), callback);
        }
    };

    /**
     * Watch a filesystem entry beneath a given watchedRoot.
     *
     * @private
     * @param {FileSystemEntry} entry - The FileSystemEntry to watch. Must be a
     *      non-strict descendent of watchedRoot.entry.
     * @param {WatchedRoot} watchedRoot - See FileSystem._watchedRoots.
     * @param {function(?string)} callback - A function that is called once the
     *      watch is complete, possibly with a FileSystemError string.
     */
    FileSystem.prototype._watchEntry = function (entry, watchedRoot, callback) {
        this._watchOrUnwatchEntry(entry, watchedRoot, callback, true);
    };

    /**
     * Unwatch a filesystem entry beneath a given watchedRoot.
     *
     * @private
     * @param {FileSystemEntry} entry - The FileSystemEntry to watch. Must be a
     *      non-strict descendent of watchedRoot.entry.
     * @param {WatchedRoot} watchedRoot - See FileSystem._watchedRoots.
     * @param {function(?string)} callback - A function that is called once the
     *      watch is complete, possibly with a FileSystemError string.
     */
    FileSystem.prototype._unwatchEntry = function (entry, watchedRoot, callback) {
        this._watchOrUnwatchEntry(entry, watchedRoot, function (err) {
            // Make sure to clear cached data for all unwatched entries because
            // entries always return cached data if it exists!
            this._index.visitAll(function (child) {
                if (child.fullPath.indexOf(entry.fullPath) === 0) {
                    // 'true' so entry doesn't try to clear its immediate childrens' caches too. That would be redundant
                    // with the visitAll() here, and could be slow if we've already cleared its parent (#7150).
                    child._clearCachedData(true);
                }
            }.bind(this));

            callback(err);
        }.bind(this), false);
    };

    /**
     * Initialize this FileSystem instance.
     *
     * @param {FileSystemImpl} impl The back-end implementation for this
     *      FileSystem instance.
     */
    FileSystem.prototype.init = function (impl) {
        console.assert(!this._impl, "This FileSystem has already been initialized!");

        var changeCallback = this._enqueueExternalChange.bind(this),
            offlineCallback = this._unwatchAll.bind(this);

        this._impl = impl;
        this._impl.initWatchers(changeCallback, offlineCallback);
    };

    /**
     * Close a file system. Clear all caches, indexes, and file watchers.
     */
    FileSystem.prototype.close = function () {
        this._impl.unwatchAll();
        this._index.clear();
    };

    /**
     * Will never remove the given file from index. Useful if you want to always hold cache the file.
     */
    FileSystem.prototype.alwaysIndex = function (filePath) {
        this._index.doNotRemoveFromIndex(filePath);
    };

    /**
     * Returns true if the given path should be automatically added to the index & watch list when one of its ancestors
     * is a watch-root. (Files are added automatically when the watch-root is first established, or later when a new
     * directory is created and its children enumerated).
     *
     * Entries explicitly created via FileSystem.getFile/DirectoryForPath() are *always* added to the index regardless
     * of this filtering - but they will not be watched if the watch-root's filter excludes them.
     *
     * @param {string} path Full path
     * @param {string} name Name portion of the path
     */
    FileSystem.prototype._indexFilter = function (path, name) {
        var parentRoot = this._findWatchedRootForPath(path);

        if (parentRoot) {
            return parentRoot.filter(name, path);
        }

        // It might seem more sensible to return false (exclude) for files outside the watch roots, but
        // that would break usage of appFileSystem for 'system'-level things like enumerating extensions.
        // (Or in general, Directory.getContents() for any Directory outside the watch roots).
        return true;
    };

    /**
     * Indicates that a filesystem-mutating operation has begun. As long as there
     * are changes taking place, change events from the external watchers are
     * blocked and queued, to be handled once changes have finished. This is done
     * because for mutating operations that originate from within the filesystem,
     * synthetic change events are fired that do not depend on external file
     * watchers, and we prefer the former over the latter for the following
     * reasons: 1) there is no delay; and 2) they may have higher fidelity ---
     * e.g., a rename operation can be detected as such, instead of as a nearly
     * simultaneous addition and deletion.
     *
     * All operations that mutate the file system MUST begin with a call to
     * _beginChange and must end with a call to _endChange.
     */
    FileSystem.prototype._beginChange = function () {
        this._activeChangeCount++;
        //console.log("> beginChange  -> " + this._activeChangeCount);
    };

    /**
     * Indicates that a filesystem-mutating operation has completed. See
     * FileSystem._beginChange above.
     */
    FileSystem.prototype._endChange = function () {
        this._activeChangeCount--;
        //console.log("< endChange    -> " + this._activeChangeCount);

        if (this._activeChangeCount < 0) {
            console.error("FileSystem _activeChangeCount has fallen below zero!");
        }

        if (!this._activeChangeCount) {
            this._triggerExternalChangesNow();
        }
    };

    /**
     * Determines whether or not the supplied path is absolute, as opposed to relative.
     *
     * @param {!string} fullPath
     * @return {boolean} True if the fullPath is absolute and false otherwise.
     */
    FileSystem.isAbsolutePath = function (fullPath) {
        return (fullPath[0] === "/" || (fullPath[1] === ":" && fullPath[2] === "/"));
    };

    function _ensureTrailingSlash(path) {
        if (path[path.length - 1] !== "/") {
            path += "/";
        }

        return path;
    }

    /*
     * Matches continguous groups of forward slashes
     * @const
     */
    var _DUPLICATED_SLASH_RE = /\/{2,}/g;

    /**
     * Returns a canonical version of the path: no duplicated "/"es, no ".."s,
     * and directories guaranteed to end in a trailing "/"
     * @param {!string} path  Absolute path, using "/" as path separator
     * @param {boolean=} isDirectory
     * @return {!string}
     */
    FileSystem.prototype._normalizePath = function (path, isDirectory) {

        if (!FileSystem.isAbsolutePath(path)) {
            throw new Error("Paths must be absolute: '" + path + "'");  // expect only absolute paths
        }

        var isUNCPath = this._impl.normalizeUNCPaths && path.search(_DUPLICATED_SLASH_RE) === 0;

        // Remove duplicated "/"es
        path = path.replace(_DUPLICATED_SLASH_RE, "/");

        // Remove ".." segments
        if (path.indexOf("..") !== -1) {
            var segments = path.split("/"),
                i;
            for (i = 1; i < segments.length; i++) {
                if (segments[i] === "..") {
                    if (i < 2) {
                        throw new Error("Invalid absolute path: '" + path + "'");
                    }
                    segments.splice(i - 1, 2);
                    i -= 2; // compensate so we start on the right index next iteration
                }
            }
            path = segments.join("/");
        }

        if (isDirectory) {
            // Make sure path DOES include trailing slash
            path = _ensureTrailingSlash(path);
        }

        if (isUNCPath) {
            // Restore the leading double slash that was removed previously
            path = "/" + path;
        }

        return path;
    };

    /**
     * This method adds an entry for a file in the file Index. Files on disk are added
     * to the file index either on load or on open. This method is primarily needed to add
     * in memory files to the index
     *
     * @param {File} The fileEntry which needs to be added
     * @param {String} The full path to the file
     */
    FileSystem.prototype.addEntryForPathIfRequired = function (fileEntry, path) {
        var entry = this._index.getEntry(path);

        if (!entry) {
            this._index.addEntry(fileEntry);
        }
    };

    /**
     * Return a (strict subclass of a) FileSystemEntry object for the specified
     * path using the provided constuctor. For now, the provided constructor
     * should be either File or Directory.
     *
     * @private
     * @param {function(string, FileSystem)} EntryConstructor Constructor with
     *      which to initialize new FileSystemEntry objects.
     * @param {string} path Absolute path of file.
     * @return {File|Directory} The File or Directory object. This file may not
     *      yet exist on disk.
     */
    FileSystem.prototype._getEntryForPath = function (EntryConstructor, path) {
        var isDirectory = EntryConstructor === Directory;
        path = this._normalizePath(path, isDirectory);
        var entry = this._index.getEntry(path);

        if (!entry) {
            entry = new EntryConstructor(path, this);
            this._index.addEntry(entry);
        }

        return entry;
    };

    /**
     * Return a File object for the specified path.
     *
     * @param {string} path Absolute path of file.
     *
     * @return {File} The File object. This file may not yet exist on disk.
     */
    FileSystem.prototype.getFileForPath = function (path) {
        let virtualServingPath = Phoenix.VFS.getPathForVirtualServingURL(path);
        if(virtualServingPath) {
            // this is so that extensions that load from an http path can figure out the actual file system path
            // from just the virtual serving URL.
            // FileSystem.getDirectoryForPath(ExtensionUtils.getModulePath(module, "some FolderInModule/"))
            path = virtualServingPath;
        }
        var protocol = PathUtils.parseUrl(path).protocol,
            protocolAdapter = _getProtocolAdapter(protocol);

        if (protocolAdapter && protocolAdapter.fileImpl) {
            return new protocolAdapter.fileImpl(protocol, path, this);
        }
        return this._getEntryForPath(File, path);

    };

    function _getNewPath(suggestedPath, isDir, i, pathLib) {
        suggestedPath = pathLib.normalize(suggestedPath);
        if(isDir){
            return `${suggestedPath} (copy ${i})`;
        } else {
            const dir = pathLib.dirname(suggestedPath),
                extName = pathLib.extname(suggestedPath),
                baseName = pathLib.basename(suggestedPath, extName);
            return pathLib.join(dir, `${baseName}(copy ${i})${extName}`);
        }
    }

    /**
     * copies a file/folder path from src to destination recursively. follows unix copy semantics mostly.
     * As with unix copy, the destination path may not be exactly the `dst` path provided.
     * Eg. copy("/a/b", "/a/x") -> will copy to `/a/x/b` if folder `/a/x` exists. If dst `/a/x` not exists,
     * then copy will honor the given destination `/a/x`
     *
     * @param {string} src Absolute path of file or directory to copy
     * @param {string} dst Absolute path of file or directory destination
     * @param {function(err, string)} callback Callback with err or stat of copied destination.
     */
    FileSystem.prototype.copy = function (src, dst, callback) {
        let self = this;
        // Block external change events until after the write has finished
        self._beginChange();
        self._impl.copy(src, dst, async function (err, stat) {
            if (err) {
                callback(err);
                self._endChange();
                return;
            }
            let target;
            if(stat.isFile){
                let parentDir = window.path.dirname(stat.realPath);
                target = self.getDirectoryForPath(parentDir);
            } else {
                target = self.getDirectoryForPath(stat.realPath);
            }
            self._handleDirectoryChange(target, function (added, removed) {
                try {
                    callback(null, stat);
                } finally {
                    if (target._isWatched()) {
                        self._fireChangeEvent(target, added, removed);
                    }
                    // Unblock external change events
                    self._endChange();
                }
            });
        });
    };

    /**
     * Return a path that is free to use for the given suggestedPath.
     * If suggestedPath is, Eg: `/a/b/dir` , then if `/a/b/dir` does not exist, it will be returned as is.
     *
     * if suggestedPath exists and is a dir, then the next available path will be returned like
     * `/a/b/dir(copy)`, /a/b/dir(copy 1)`...
     *
     * if suggestedPath exists and is a file say `/a/b/test.html`, then the next available path will be returned like
     * `/a/b/test (copy).html`, /a/b/test (copy 1).html`...
     *
     * @param {string} suggestedPath Absolute path of file or directory to check if free.
     * @param {function(err, string)} callback Callback with err or Absolute path that is free to use.
     */
    FileSystem.prototype.getFreePath = function (suggestedPath, callback) {
        let self = this;
        self._impl.stat(suggestedPath, async function (err, stat) {
            if (stat) {
                // find a suggested path
                let isDir = stat.isDirectory;
                for(let i = 1; i < MAX_DEDUPE_NUMBER; i++) {
                    let newPath = _getNewPath(suggestedPath, isDir, i, self._impl.pathLib);
                    let exists = await self._impl.existsAsync(newPath);
                    if(!exists){
                        callback(null, newPath);
                        return;
                    }
                }
                callback(FileSystemError.TOO_MANY_ENTRIES);
                return;
            } else if (err && err === FileSystemError.NOT_FOUND) {
                callback(null, suggestedPath);
                return;
            }
            callback(err);
        });
    };

    /**
     * Return a Directory object for the specified path.
     *
     * @param {string} path Absolute path of directory.
     *
     * @return {Directory} The Directory object. This directory may not yet exist on disk.
     */
    FileSystem.prototype.getDirectoryForPath = function (path) {
        let virtualServingPath = Phoenix.VFS.getPathForVirtualServingURL(path);
        if(virtualServingPath) {
            // this is so that extensions that load from an http path can figure out the actual file system path
            // from just the virtual serving URL.
            // FileSystem.getDirectoryForPath(ExtensionUtils.getModulePath(module, "some FolderInModule/"))
            path = virtualServingPath;
        }
        return this._getEntryForPath(Directory, path);
    };

    /**
     * Resolve a path.
     *
     * @param {string} path The path to resolve
     * @param {function (?string, FileSystemEntry=, FileSystemStats=)} callback Callback resolved
     *      with a FileSystemError string or with the entry for the provided path.
     */
    FileSystem.prototype.resolve = function (path, callback) {
        var normalizedPath = this._normalizePath(path, false),
            item = this._index.getEntry(normalizedPath);

        if (!item) {
            normalizedPath = _ensureTrailingSlash(normalizedPath);
            item = this._index.getEntry(normalizedPath);
        }

        if (item) {
            item.stat(function (err, stat) {
                if (err) {
                    callback(err);
                    return;
                }

                callback(null, item, stat);
            });
        } else {
            this._impl.stat(path, function (err, stat) {
                if (err) {
                    callback(err);
                    return;
                }

                if (stat.isFile) {
                    item = this.getFileForPath(path);
                } else {
                    item = this.getDirectoryForPath(path);
                }

                if (item._isWatched()) {
                    item._stat = stat;
                }

                callback(null, item, stat);
            }.bind(this));
        }
    };

    /**
     * Determine whether a file or directory exists at the given path
     * resolved to a boolean, which is true if the file exists and false otherwise.
     * The error will never be FileSystemError.NOT_FOUND; in that case, there will be no error and the
     * boolean parameter will be false.
     *
     * @param {string} path
     * @param {function(?string, boolean)} callback
     */
    FileSystem.prototype.existsAsync = function (path) {
        return this._impl.existsAsync(path);
    };

    /**
     * promisified version of FileSystem.resolve
     * @param {String} path to resolve
     * @returns {Promise<{entry, stat}>}
     */
    FileSystem.prototype.resolveAsync = function (path) {
        let self = this;
        return new Promise((resolve, reject)=>{
            self.resolve(path, (err, item, stat)=>{
                if(err){
                    reject(err);
                    return;
                }
                resolve({
                    entry: item,
                    stat: stat
                });
            });
        });
    };

    /**
     * Show an "Open" dialog and return the file(s)/directories selected by the user.
     *
     * @param {boolean} allowMultipleSelection Allows selecting more than one file at a time
     * @param {boolean} chooseDirectories Allows directories to be opened
     * @param {string} title The title of the dialog
     * @param {string} initialPath The folder opened inside the window initially. If initialPath
     *                          is not set, or it doesn't exist, the window would show the last
     *                          browsed folder depending on the OS preferences
     * @param {?Array.<string>} fileTypes (Currently *ignored* except on Mac - https://trello.com/c/430aXkpq)
     *                          List of extensions that are allowed to be opened, without leading ".".
     *                          Null or empty array allows all files to be selected. Not applicable
     *                          when chooseDirectories = true.
     * @param {function (?string, Array.<string>=)} callback Callback resolved with a FileSystemError
     *                          string or the selected file(s)/directories. If the user cancels the
     *                          open dialog, the error will be falsy and the file/directory array will
     *                          be empty.
     */
    FileSystem.prototype.showOpenDialog = function (allowMultipleSelection,
                            chooseDirectories,
                            title,
                            initialPath,
                            fileTypes,
                            callback) {

        this._impl.showOpenDialog(allowMultipleSelection, chooseDirectories, title, initialPath, fileTypes, callback);
    };

    /**
     * Show a "Save" dialog and return the path of the file to save.
     *
     * @param {string} title The title of the dialog.
     * @param {string} initialPath The folder opened inside the window initially. If initialPath
     *                          is not set, or it doesn't exist, the window would show the last
     *                          browsed folder depending on the OS preferences.
     * @param {string} proposedNewFilename Provide a new file name for the user. This could be based on
     *                          on the current file name plus an additional suffix
     * @param {function (?string, string=)} callback Callback that is resolved with a FileSystemError
     *                          string or the name of the file to save. If the user cancels the save,
     *                          the error will be falsy and the name will be empty.
     */
    FileSystem.prototype.showSaveDialog = function (title, initialPath, proposedNewFilename, callback) {
        this._impl.showSaveDialog(title, initialPath, proposedNewFilename, callback);
    };

    /**
     * Fire a rename event. Clients listen for these events using FileSystem.on.
     *
     * @param {string} oldPath The entry's previous fullPath
     * @param {string} newPath The entry's current fullPath
     */
    FileSystem.prototype._fireRenameEvent = function (oldPath, newPath) {
        this.trigger("rename", oldPath, newPath);
    };

    /**
     * Fire a change event. Clients listen for these events using FileSystem.on.
     *
     * @param {File|Directory} entry The entry that has changed
     * @param {Array<File|Directory>=} added If the entry is a directory, this
     *      is a set of new entries in the directory.
     * @param {Array<File|Directory>=} removed If the entry is a directory, this
     *      is a set of removed entries from the directory.
     */
    FileSystem.prototype._fireChangeEvent = function (entry, added, removed) {
        this.trigger("change", entry, added, removed);
    };

    /**
     * @private
     * Notify the system when an entry name has changed.
     *
     * @param {string} oldFullPath
     * @param {string} newFullPath
     * @param {boolean} isDirectory
     */
    FileSystem.prototype._handleRename = function (oldFullPath, newFullPath, isDirectory) {
        // Update all affected entries in the index
        this._index.entryRenamed(oldFullPath, newFullPath, isDirectory);
    };

    /**
     * Notify the filesystem that the given directory has changed. Updates the filesystem's
     * internal state as a result of the change, and calls back with the set of added and
     * removed entries. Mutating FileSystemEntry operations should call this method before
     * applying the operation's callback, and pass along the resulting change sets in the
     * internal change event.
     *
     * @param {Directory} directory The directory that has changed.
     * @param {function(Array<File|Directory>=, Array<File|Directory>=)} callback
     *      The callback that will be applied to a set of added and a set of removed
     *      FileSystemEntry objects.
     */
    FileSystem.prototype._handleDirectoryChange = function (directory, callback) {
        var oldContents = directory._contents;

        directory._clearCachedData();
        directory.getContents(function (err, contents) {
            var addedEntries = oldContents && contents.filter(function (entry) {
                return oldContents.indexOf(entry) === -1;
            });

            var removedEntries = oldContents && oldContents.filter(function (entry) {
                return contents.indexOf(entry) === -1;
            });

            // If directory is not watched, clear children's caches manually.
            var watchedRoot = this._findWatchedRootForPath(directory.fullPath);
            if (!watchedRoot || !watchedRoot.filter(directory.name, directory.parentPath)) {
                this._index.visitAll(function (entry) {
                    if (entry.fullPath.indexOf(directory.fullPath) === 0) {
                        // Passing 'true' for a similar reason as in _unwatchEntry() - see #7150
                        entry._clearCachedData(true);
                    }
                }.bind(this));

                callback(addedEntries, removedEntries);
                return;
            }

            var addedCounter = addedEntries ? addedEntries.length : 0,
                removedCounter = removedEntries ? removedEntries.length : 0,
                counter = addedCounter + removedCounter;

            if (counter === 0) {
                callback(addedEntries, removedEntries);
                return;
            }

            var watchOrUnwatchCallback = function (err) {
                if (err) {
                    console.error("FileSystem error in _handleDirectoryChange after watch/unwatch entries: " + err);
                }

                if (--counter === 0) {
                    callback(addedEntries, removedEntries);
                }
            };

            if (addedEntries) {
                addedEntries.forEach(function (entry) {
                    this._watchEntry(entry, watchedRoot, watchOrUnwatchCallback);
                }, this);
            }

            if (removedEntries) {
                removedEntries.forEach(function (entry) {
                    this._unwatchEntry(entry, watchedRoot, watchOrUnwatchCallback);
                }, this);
            }
        }.bind(this));
    };

    /**
     * @private
     * Processes a result from the file/directory watchers. Watch results are sent from the low-level implementation
     * whenever a directory or file is changed.
     *
     * @param {string} path The path that changed. This could be a file or a directory.
     * @param {FileSystemStats=} stat Optional stat for the item that changed. This param is not always
     *         passed.
     */
    FileSystem.prototype._handleExternalChange = function (path, stat) {

        if (!path) {
            // This is a "wholesale" change event; clear all caches
            this._index.visitAll(function (entry) {
                // Passing 'true' for a similar reason as in _unwatchEntry() - see #7150
                entry._clearCachedData(true);
            });

            this._fireChangeEvent(null);
            return;
        }

        path = this._normalizePath(path, false);

        var entry = this._index.getEntry(path);
        if (entry) {
            var oldStat = entry._stat;
            if (entry.isFile) {
                // Update stat and clear contents, but only if out of date
                if (!(stat && oldStat && stat.mtime.getTime() <= oldStat.mtime.getTime())) {
                    entry._clearCachedData();
                    entry._stat = stat;
                    this._fireChangeEvent(entry);
                }
            } else {
                this._handleDirectoryChange(entry, function (added, removed) {
                    entry._stat = stat;

                    if (entry._isWatched()) {
                        // We send a change even if added & removed are both zero-length. Something may still have changed,
                        // e.g. a file may have been quickly removed & re-added before we got a chance to reread the directory
                        // listing.
                        this._fireChangeEvent(entry, added, removed);
                    }
                }.bind(this));
            }
        }
    };

    /**
     * Recursively gets all files and directories given a root path.
     * @param {Directory} directory To get all descendant contents from
     * @return {Promise<Array[File|Directory]>} A promise that resolves with the file and directory contents
     */
    FileSystem.prototype.getAllDirectoryContents = function (directory) {
        return new Promise((resolve, reject)=>{
            let contents = [];
            function visitor(entry) {
                if(directory.fullPath !== entry.fullPath){
                    contents.push(entry);
                }
                return true;
            }
            directory.visit(visitor, (err)=>{
                if(err){
                    reject(err);
                    return;
                }
                resolve(contents);
            });
        });
    };
    /**
     * Clears all cached content. Because of the performance implications of this, this should only be used if
     * there is a suspicion that the file system has not been updated through the normal file watchers
     * mechanism.
     */
    FileSystem.prototype.clearAllCaches = function () {
        this._handleExternalChange(null);
    };

    /**
     * Start watching a filesystem root entry.
     *
     * @param {FileSystemEntry} entry - The root entry to watch. If entry is a directory,
     *      all subdirectories that aren't explicitly filtered will also be watched.
     * @param {function(string): boolean} filter - Returns true if a particular item should
     *      be watched, given its name (not full path). Items that are ignored are also
     *      filtered from Directory.getContents() results within this subtree.
     * @param {string|Array<string>} filterGitIgnore - GitIgnore file contents or as arrayof strings for
     *      filtering out events on the node side.
     * @param {function(?string)=} callback - A function that is called when the watch has
     *      completed. If the watch fails, the function will have a non-null FileSystemError
     *      string parametr.
     */
    FileSystem.prototype.watch = function (entry, filter, filterGitIgnore, callback) {
        // make filterGitIgnore an optional argument to stay backwards compatible
        if (typeof callback === "undefined" && typeof filterGitIgnore === "function") {
            callback = filterGitIgnore;
            filterGitIgnore = null;
        }

        var fullPath = entry.fullPath;

        callback = callback || function () {};

        var watchingParentRoot = this._findWatchedRootForPath(fullPath);
        if (watchingParentRoot &&
                (watchingParentRoot.status === WatchedRoot.STARTING ||
                 watchingParentRoot.status === WatchedRoot.ACTIVE)) {
            callback("A parent of this root is already watched");
            return;
        }

        var watchingChildRoot = Object.keys(this._watchedRoots).some(function (path) {
            var watchedRoot = this._watchedRoots[path],
                watchedPath = watchedRoot.entry.fullPath;

            return watchedPath.indexOf(fullPath) === 0;
        }, this);

        if (watchingChildRoot &&
                (watchingChildRoot.status === WatchedRoot.STARTING ||
                 watchingChildRoot.status === WatchedRoot.ACTIVE)) {
            callback("A child of this root is already watched");
            return;
        }

        const watchedRoot = new WatchedRoot(entry, filter, filterGitIgnore);

        this._watchedRoots[fullPath] = watchedRoot;

        // Enter the STARTING state early to indiate that watched Directory
        // objects may cache their contents. See FileSystemEntry._isWatched.
        watchedRoot.status = WatchedRoot.STARTING;

        this._watchEntry(entry, watchedRoot, function (err) {
            if (err) {
                console.warn("Failed to watch root: ", entry.fullPath, err);
                delete this._watchedRoots[fullPath];
                callback(err);
                return;
            }

            watchedRoot.status = WatchedRoot.ACTIVE;

            callback(null);
        }.bind(this));
    };

    /**
     * Stop watching a filesystem root entry.
     *
     * @param {FileSystemEntry} entry - The root entry to stop watching. The unwatch will
     *      if the entry is not currently being watched.
     * @param {function(?string)=} callback - A function that is called when the unwatch has
     *      completed. If the unwatch fails, the function will have a non-null FileSystemError
     *      string parameter.
     */
    FileSystem.prototype.unwatch = function (entry, callback) {
        var fullPath = entry.fullPath,
            watchedRoot = this._watchedRoots[fullPath];

        callback = callback || function () {};

        if (!watchedRoot) {
            callback(FileSystemError.ROOT_NOT_WATCHED);
            return;
        }

        // Mark this as inactive, but don't delete the entry until the unwatch is complete.
        // This is useful for making sure we don't try to concurrently watch overlapping roots.
        watchedRoot.status = WatchedRoot.INACTIVE;

        this._unwatchEntry(entry, watchedRoot, function (err) {
            delete this._watchedRoots[fullPath];

            this._index.visitAll(function (child) {
                if (child.fullPath.indexOf(entry.fullPath) === 0) {
                    this._index.removeEntry(child);
                }
            }.bind(this));

            if (err) {
                console.warn("Failed to unwatch root: ", entry.fullPath, err);
                callback(err);
                return;
            }

            callback(null);
        }.bind(this));
    };

    /**
     * Unwatch all watched roots. Calls unwatch on the underlying impl for each
     * watched root and ignores errors.
     * @private
     */
    FileSystem.prototype._unwatchAll = function () {
        console.warn("File watchers went offline!");

        Object.keys(this._watchedRoots).forEach(function (path) {
            var watchedRoot = this._watchedRoots[path];

            watchedRoot.status = WatchedRoot.INACTIVE;
            delete this._watchedRoots[path];
            this._unwatchEntry(watchedRoot.entry, watchedRoot, function () {
                console.warn("Watching disabled for", watchedRoot.entry.fullPath);
            });
        }, this);

        // Fire a wholesale change event, clearing all caches and request that
        // clients manually update their state.
        this._handleExternalChange(null);
    };


    // The singleton instance
    var _instance;

    function _wrap(func) {
        return function () {
            return func.apply(_instance, arguments);
        };
    }

    // Export public methods as proxies to the singleton instance
    exports.init = _wrap(FileSystem.prototype.init);
    exports.close = _wrap(FileSystem.prototype.close);
    exports.getFileForPath = _wrap(FileSystem.prototype.getFileForPath);
    exports.addEntryForPathIfRequired = _wrap(FileSystem.prototype.addEntryForPathIfRequired);
    exports.getDirectoryForPath = _wrap(FileSystem.prototype.getDirectoryForPath);
    exports.resolve = _wrap(FileSystem.prototype.resolve);
    exports.resolveAsync = _wrap(FileSystem.prototype.resolveAsync);
    exports.showOpenDialog = _wrap(FileSystem.prototype.showOpenDialog);
    exports.showSaveDialog = _wrap(FileSystem.prototype.showSaveDialog);
    exports.watch = _wrap(FileSystem.prototype.watch);
    exports.unwatch = _wrap(FileSystem.prototype.unwatch);
    exports.clearAllCaches = _wrap(FileSystem.prototype.clearAllCaches);
    exports.alwaysIndex = _wrap(FileSystem.prototype.alwaysIndex);
    exports.getFreePath = _wrap(FileSystem.prototype.getFreePath);
    exports.copy = _wrap(FileSystem.prototype.copy);
    exports.existsAsync = _wrap(FileSystem.prototype.existsAsync);
    exports.getAllDirectoryContents = _wrap(FileSystem.prototype.getAllDirectoryContents);

    // Static public utility methods
    exports.isAbsolutePath = FileSystem.isAbsolutePath;
    exports.registerProtocolAdapter = registerProtocolAdapter;

    // For testing only
    exports._getActiveChangeCount = _wrap(FileSystem.prototype._getActiveChangeCount);

    /**
     * Add an event listener for a FileSystem event.
     *
     * @param {string} event The name of the event
     * @param {function} handler The handler for the event
     */
    exports.on = function (event, handler) {
        _instance.on(event, handler);
    };

    /**
     * Remove an event listener for a FileSystem event.
     *
     * @param {string} event The name of the event
     * @param {function} handler The handler for the event
     */
    exports.off = function (event, handler) {
        _instance.off(event, handler);
    };

    // Export the FileSystem class as "private" for unit testing only.
    exports._FileSystem = FileSystem;

    // Create the singleton instance
    _instance = new FileSystem();

    // Initialize the singleton instance
    _instance.init(require("fileSystemImpl"));

    // attach remote file handlers
    var HTTP_PROTOCOL = "http:",
        HTTPS_PROTOCOL = "https:";

    var protocolAdapter = {
        priority: 0, // Default priority
        fileImpl: RemoteFile,
        canRead: function (filePath) {
            return true; // Always claim true, we are the default adpaters
        }
    };

    // Register the custom object as HTTP and HTTPS protocol adapter
    registerProtocolAdapter(HTTP_PROTOCOL, protocolAdapter);
    registerProtocolAdapter(HTTPS_PROTOCOL, protocolAdapter);
});
