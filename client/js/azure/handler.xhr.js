/*globals qq */
/**
 * Upload handler used by the upload to Azure module that depends on File API support, and, therefore, makes use of
 * `XMLHttpRequest` level 2 to upload `File`s and `Blob`s directly to Azure Blob Storage containers via the
 * associated Azure API.
 *
 * @param spec Options passed from the base handler
 * @param proxy Callbacks & methods used to query for or push out data/changes
 */
// TODO l18n for error messages returned to UI
// TODO resume support
// TODO only chunk when necessary/desired
qq.azure.UploadHandlerXhr = function(spec, proxy) {
    "use strict";

    var publicApi = this,
        internalApi = {},
        fileState = [],
        log = proxy.log,
        cors = spec.cors,
        endpointStore = spec.endpointStore,
        paramsStore = spec.paramsStore,
        signature = spec.signature,
        chunkingPossible = spec.chunking.enabled && qq.supportedFeatures.chunking,
        deleteBlob = spec.deleteBlob,
        resumeEnabled = spec.resume.enabled && chunkingPossible && qq.supportedFeatures.resume && window.localStorage !== undefined,
        onGetBlobName = spec.onGetBlobName,
        onProgress = spec.onProgress,
        onComplete = spec.onComplete,
        onUpload = spec.onUpload,
        onUploadChunk = spec.onUploadChunk,
        onUploadChunkSuccess = spec.onUploadChunkSuccess,
        onUuidChanged = proxy.onUuidChanged,
        onUploadComplete = function(id, xhr, errorMsg) {
            var azureError;

            if (errorMsg) {
                azureError = qq.azure.util.parseAzureError(xhr.responseText, log);
                if (!spec.onAutoRetry(id, getName(id), {error: errorMsg, azureError: azureError && azureError.message}, xhr)) {
                    onComplete(id, getName(id), {success: false, error: errorMsg, azureError: azureError && azureError.message}, xhr);
                }
            }
            else {
                onComplete(id, getName(id), {success: true}, xhr);
            }
        },
        getName = proxy.getName,
        getUuid = proxy.getUuid,
        getSize = proxy.getSize,
        progressHandler = function(id, loaded, total) {
            if (shouldChunkThisFile(id)) {
                onProgress(id, getName(id), loaded + fileState[id].loaded, getSize(id));
            }
            else {
                fileState[id].loaded = loaded;
                onProgress(id, getName(id), loaded, total);
            }
        },
        putBlob = new qq.azure.PutBlob({
            onProgress: progressHandler,
            onUpload: function(id) {
                onUpload(id, getName(id));
            },
            onComplete: function(id, xhr, isError) {
                if (isError) {
                    log("Put Blob call failed for " + id, "error");
                }
                else {
                    log("Put Blob call succeeded for " + id);
                }

                onUploadComplete.call(this, id, xhr, isError ? "Problem sending file to Azure" : null);
            },
            log: log
        }),
        putBlock = new qq.azure.PutBlock({
            onProgress: progressHandler,
            onUpload: function(id) {
                var partIdx = getNextPartIdxToSend(id),
                    chunkData = internalApi.getChunkData(id, partIdx);

                onUploadChunk(id, getName(id), internalApi.getChunkDataForCallback(chunkData));
            },
            onComplete: function(id, xhr, isError, blockId) {
                var partIdx = getNextPartIdxToSend(id),
                    chunkData = internalApi.getChunkData(id, partIdx),
                    chunkDataForCallback = internalApi.getChunkDataForCallback(chunkData);

                if (isError) {
                    log("Put Block call failed for " + id, "error");
                    onUploadComplete.call(this, id, xhr, "Problem uploading block");
                }
                else {
                    fileState[id].chunking.blockIds.push(blockId);
                    log("Put Block call succeeded for " + id);
                    fileState[id].chunking.lastSent = partIdx;

                    // Update the bytes loaded counter to reflect all bytes successfully transferred in the associated chunked request
                    fileState[id].loaded += chunkData.size;

                    //TODO fill-in response
                    onUploadChunkSuccess(id, chunkDataForCallback, {}, xhr);

                    maybeUploadNextChunk(id);
                }
            },
            log: log
        }),
        putBlockList = new qq.azure.PutBlockList({
            onComplete: function(id, xhr, isError) {
                if (isError) {
                    log("Attempt to combine chunks failed for id " + id, "error");
                    onUploadComplete.call(this, id, xhr, "Problem combining file pieces");
                }
                else {
                    log("Success combining chunks for id " + id);
                    onUploadComplete.call(this, id, xhr);
                }
            },
            log: log
        }),
        getSasForPutBlobOrBlock = new qq.azure.GetSas({
            cors: cors,
            endpointStore: {
                get: function() {
                    return signature.endpoint;
                }
            },
            customHeaders: signature.customHeaders,
            restRequestVerb: putBlob.method,
            log: log
        });

    function determineBlobUrl(id) {
        var containerUrl = endpointStore.get(id),
            promise = new qq.Promise(),
            getBlobNameSuccess = function(blobName) {
                fileState[id].blobName = blobName;
                promise.success(containerUrl + "/" + blobName);
            },
            getBlobNameFailure = function(reason) {
                promise.failure(reason);
            };

        onGetBlobName(id).then(getBlobNameSuccess, getBlobNameFailure);

        return promise;
    }

    /**
     * Determine if the associated file should be chunked.
     *
     * @param id ID of the associated file
     * @returns {*} true if chunking is enabled, possible, and the file can be split into more than 1 part
     */
    // TODO DRY - duplicated in S3 XHR
    function shouldChunkThisFile(id) {
        var totalChunks;

        if (!fileState[id].chunking) {
            fileState[id].chunking = {
                blockIds: []
            };
            totalChunks = internalApi.getTotalChunks(id);
            if (totalChunks > 1) {
                fileState[id].chunking.enabled = true;
                fileState[id].chunking.parts = totalChunks;
            }
            else {
                fileState[id].chunking.enabled = false;
            }
        }

        return fileState[id].chunking.enabled;
    }

    function handleStartUploadSignal(id) {
        if (shouldChunkThisFile(id)) {
            // We might be retrying a failed in-progress upload, so it's important that we
            // don't reset this value so we don't wipe out the record of all successfully
            // uploaded chunks for this file.
            if (fileState[id].loaded === undefined) {
                fileState[id].loaded = 0;
            }

            onUpload(id, getName(id));
            maybeUploadNextChunk(id);
        }
        else {
            handleSimpleUpload(id);
        }
    }

    function getSignedUrl(id, onSuccess) {
        var getSasSuccess = function(sasUri) {
                log("GET SAS request succeeded.");
                onSuccess(sasUri);
            },
            getSasFailure = function(reason, getSasXhr) {
                log("GET SAS request failed: " + reason, "error");
                onUploadComplete(id, getSasXhr, "Problem communicating with local server");
            },
            determineBlobUrlSuccess = function(blobUrl) {
                getSasForPutBlobOrBlock.request(id, blobUrl).then(
                    getSasSuccess,
                    getSasFailure
                );
            },
            determineBlobUrlFailure = function(reason) {
                log(qq.format("Failed to determine blob name for ID {} - {}", id, reason), "error");
                onUploadComplete(id, null, "Problem determining name of file to upload");
            };

        determineBlobUrl(id).then(determineBlobUrlSuccess, determineBlobUrlFailure);
    }

    function handleSimpleUpload(id) {
        var fileOrBlob = publicApi.getFile(id),
            params = paramsStore.get(id);

        getSignedUrl(id, function(sasUri) {
            var xhr = putBlob.upload(id, sasUri, qq.azure.util.getParamsAsHeaders(params), fileOrBlob);
            internalApi.registerXhr(id, xhr, putBlob);
        });
    }

    /**
     * Retrieves the 0-based index of the next chunk to send.  Note that AWS uses 1-based indexing.
     *
     * @param id File ID
     * @returns {number} The 0-based index of the next file chunk to be sent to S3
     */
    function getNextPartIdxToSend(id) {
        return fileState[id].chunking.lastSent >= 0 ? fileState[id].chunking.lastSent + 1 : 0;
    }

    function maybeUploadNextChunk(id) {
        var totalParts = fileState[id].chunking.parts,
            nextPartIdx = getNextPartIdxToSend(id);

        if (publicApi.isValid(id) && nextPartIdx < totalParts) {
            uploadNextChunk(id, nextPartIdx);
        }
        else {
            combineChunks(id);
        }
    }

    function uploadNextChunk(id, partIdx) {
        getSignedUrl(id, function(sasUri) {
            var chunkData = internalApi.getChunkData(id, partIdx),
                xhr = putBlock.upload(id, sasUri, partIdx, chunkData.blob);

            internalApi.registerXhr(id, xhr, putBlock);
        });
    }

    function combineChunks(id) {
        getSignedUrl(id, function(sasUri) {
            var mimeType = internalApi.getMimeType(id),
                params = paramsStore.get(id),
                blockIds = fileState[id].chunking.blockIds,
                customHeaders = qq.azure.util.getParamsAsHeaders(params),
                xhr = putBlockList.send(id, sasUri, blockIds, mimeType, customHeaders);

            internalApi.registerXhr(id, xhr, putBlockList);
        });
    }

    qq.extend(this, new qq.UploadHandlerXhrApi(
        internalApi,
        {fileState: fileState, chunking: chunkingPossible ? spec.chunking : null},
        {onUpload: handleStartUploadSignal, onCancel: spec.onCancel, onUuidChanged: onUuidChanged, getName: getName,
            getSize: getSize, getUuid: getUuid, log: log}
    ));

    // Base XHR API overrides
    qq.override(this, function(super_) {
        return {
            expunge: function(id) {
                var relatedToCancel = fileState[id].canceled,
                    chunkingData = fileState[id].chunking,
                    blockIds = (chunkingData && chunkingData.blockIds) || [];

                if (relatedToCancel && blockIds.length > 0) {
                    deleteBlob(id);
                }
                super_.expunge(id);
            }
        };
    });
};