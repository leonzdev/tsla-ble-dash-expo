#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

CLEAN_FLAG=""
BUILD_ONLY=0
VARIANT="debug"
EXPO_VARIANT_FLAG=""

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        -c|--clean)
            echo "Clean build requested. Clearing native build cache..."
            CLEAN_FLAG="--no-build-cache"
            # Also clean watchman and bundler cache just in case
            watchman watch-del-all || true
            rm -rf node_modules/.cache/babel-loader || true
            rm -rf node_modules/.cache/expo || true
            shift
            ;;
        -b|--build-only)
            BUILD_ONLY=1
            shift
            ;;
        -r|--release|--production)
            VARIANT="release"
            EXPO_VARIANT_FLAG="--variant release"
            shift
            ;;
        *)
            echo "Unknown parameter passed: $1"
            echo "Usage: ./build-android.sh [options]"
            echo "Options:"
            echo "  -c, --clean         Clear build caches before building"
            echo "  -b, --build-only    Build APK only, skip deploying to device"
            echo "  -r, --release       Build production (release) variant"
            exit 1
            ;;
    esac
done

if [[ $BUILD_ONLY -eq 1 ]]; then
    echo "Starting build-only mode for Android ($VARIANT variant)..."

    # Make sure android directory exists (create if missing)
    if [ ! -d "android" ]; then
        echo "Android directory not found. Running prebuild..."
        npx expo prebuild --platform android
    fi

    cd android
    
    # If clean flag passed, also clean gradle cache
    if [ -n "$CLEAN_FLAG" ]; then
        ./gradlew clean
    fi

    if [[ "$VARIANT" == "release" ]]; then
        ./gradlew assembleRelease
        echo "Successfully built release APK! You can find it in android/app/build/outputs/apk/release/"
    else
        ./gradlew assembleDebug
        echo "Successfully built debug APK! You can find it in android/app/build/outputs/apk/debug/"
    fi
else
    echo "Starting compilation and deployment for Android ($VARIANT variant)..."
    
    # This command uses Expo cli to compile the native Android project 
    # located in the /android directory and deploys the resulting APK 
    # to a connected Android device or running emulator via ADB.
    npx expo run:android $EXPO_VARIANT_FLAG $CLEAN_FLAG
    
    echo "Successfully built and deployed!"
fi
